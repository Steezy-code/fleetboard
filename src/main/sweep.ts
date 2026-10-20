import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MainContext } from './context'
import { loginEnv, which } from './env'
import { toRendererPath } from './platform'
import { dirs, readJson } from './paths'

// Morning sweep: a fast, read-only health report across all of the user's repos.
// Nothing here writes to a repo: no checkout, no index refresh (GIT_OPTIONAL_LOCKS=0), and the only
// network call into git is an opt-in `git fetch` when the user presses "Fetch remotes".
//
// IPC
//   sweep:repos            → { roots, repos: SweepCandidate[] }
//   sweep:run ({ fetch })  → SweepResult   (progress events: 'sweep:progress' { done, total, repo })
//   sweep:last             → SweepResult | null   (last result held in the main process)

export interface SweepCandidate {
  path: string
  name: string
  /** a Fleetboard project */
  known: boolean
}

export interface SweepFile {
  /** porcelain XY status, trimmed (e.g. "M", "??", "A", "RM") */
  code: string
  path: string
}

export interface SweepPr {
  number: number
  title: string
  isDraft: boolean
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' */
  reviewDecision: string
  updatedAt: string
  headRefName: string
  author: string
  url: string
}

export interface SweepCi {
  /** success | failure | cancelled | skipped | timed_out | ... | '' while running */
  conclusion: string
  status: string
  workflowName: string
  createdAt: string
  url: string
}

export interface SweepRepo {
  name: string
  path: string
  known: boolean
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** fetched this run */
  fetched: boolean
  fetchError?: string
  uncommitted: number
  untracked: number
  /** first 6 changed paths */
  files: SweepFile[]
  /** oldest mtime (ms) among the changed files, when known */
  dirtySince: number | null
  stashes: number
  lastCommit: { subject: string; relative: string; author: string; time: number } | null
  daysSinceCommit: number | null
  defaultBranch: string | null
  staleBranches: string[]
  staleCount: number
  slug: string | null
  remoteUrl: string | null
  /** gh ran for this repo */
  gh: boolean
  ghError?: string
  prs: SweepPr[]
  ci: SweepCi | null
  plan: { file: string; item: string } | null
  score: number
  attention: string[]
  error?: string
  ms: number
}

export interface SweepResult {
  at: number
  fetch: boolean
  roots: string[]
  ghAvailable: boolean
  repos: SweepRepo[]
  error?: string
}

const CMD_TIMEOUT = 8000
const FETCH_TIMEOUT = 20000
const CONCURRENCY = 6
const MAX_REPOS = 40
const DEFAULT_ROOTS = ['~/code', '~/Github', '~/projects', '~/src']
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__', 'venv'])

interface RunOut {
  code: number
  stdout: string
  stderr: string
}

function exec(bin: string, args: string[], cwd: string, env: Record<string, string>, timeout = CMD_TIMEOUT): Promise<RunOut> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      let se = String(stderr ?? '')
      if (err && !se.trim()) se = err.killed ? `${path.basename(bin)} timed out` : err.code === 'ENOENT' ? `${path.basename(bin)} not found` : String(err.message ?? err)
      resolve({ code, stdout: String(stdout ?? ''), stderr: se })
    })
  })
}

let envCache: { git: Record<string, string>; gh: Record<string, string> } | null = null
async function envs() {
  if (envCache) return envCache
  const base = await loginEnv()
  envCache = {
    git: { ...base, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    gh: { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  }
  // keep ssh from prompting for host keys / passphrases during an opt-in fetch
  if (!envCache.git.GIT_SSH_COMMAND) envCache.git.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=6'
  return envCache
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .join(' · ')
    .replace(/^(fatal|error): /i, '')
    .slice(0, 240)

const expandHome = (p: string) => (p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p)

// ---------- candidates ----------

interface AppFileLite {
  projects?: { path: string; name?: string }[]
  global?: Record<string, unknown>
}

const readApp = () => readJson<AppFileLite>(path.join(dirs.root, 'app.json'), {})

/** Scan roots from store global 'sweepRoots' (string[] or comma-separated string), else the defaults. */
export function sweepRoots(): string[] {
  const raw = readApp().global?.sweepRoots
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : DEFAULT_ROOTS
  const out = list.map((s) => s.trim()).filter(Boolean)
  return out.length ? out : DEFAULT_ROOTS
}

function realDir(p: string): string | null {
  try {
    const r = fs.realpathSync(p)
    return fs.statSync(r).isDirectory() ? r : null
  } catch {
    return null
  }
}

/** 'repo' for a normal repo, 'skip' for a linked worktree, null when not a repo. */
function gitKind(dir: string): 'repo' | 'skip' | null {
  const g = path.join(dir, '.git')
  let st: fs.Stats
  try {
    st = fs.statSync(g)
  } catch {
    return null
  }
  if (st.isDirectory()) return 'repo'
  if (st.isFile()) {
    // "gitdir: /x/.git/worktrees/name" is a linked worktree of another repo: the main repo covers it.
    try {
      const txt = fs.readFileSync(g, 'utf8')
      if (/[\\/]\.git[\\/]worktrees[\\/]/.test(txt)) return 'skip'
    } catch {
      return null
    }
    return 'repo'
  }
  return null
}

function activity(dir: string): number {
  let t = 0
  for (const f of ['.git/index', '.git/HEAD', '.git/FETCH_HEAD', '.git']) {
    try {
      t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs)
    } catch {
      /* missing */
    }
  }
  return t
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .map((d) => path.join(dir, d.name))
  } catch {
    return []
  }
}

/** Fleetboard projects ∪ git repos up to 2 levels under the roots. Capped, most recently active first. */
export function listRepos(): { roots: string[]; repos: SweepCandidate[] } {
  const roots = sweepRoots()
  const fbRoot = realDir(dirs.root) ?? dirs.root
  const seen = new Set<string>()
  const known: SweepCandidate[] = []
  const found: (SweepCandidate & { t: number })[] = []

  const accept = (p: string): string | null => {
    const r = realDir(p)
    if (!r || seen.has(r)) return null
    if (r === fbRoot || r.startsWith(fbRoot + path.sep)) return null
    if (gitKind(r) !== 'repo') return null
    seen.add(r)
    return r
  }

  for (const p of readApp().projects ?? []) {
    if (!p?.path) continue
    const r = accept(p.path)
    if (r) known.push({ path: r, name: path.basename(r), known: true })
  }

  for (const root of roots) {
    const base = realDir(expandHome(root))
    if (!base) continue
    const visit = (dir: string, depth: number) => {
      const kind = gitKind(dir)
      if (kind === 'repo') {
        const r = accept(dir)
        if (r) found.push({ path: r, name: path.basename(r), known: false, t: activity(r) })
        return
      }
      if (kind === 'skip' || depth >= 2) return
      for (const d of subdirs(dir)) visit(d, depth + 1)
    }
    visit(base, 0)
  }

  found.sort((a, b) => b.t - a.t)
  const repos = [...known, ...found.map(({ t: _t, ...c }) => c)].slice(0, MAX_REPOS)
  return { roots, repos }
}

// ---------- per repo ----------

export function parseSlug(url: string | null): string | null {
  if (!url) return null
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** Parse `git status --porcelain=v1 -z`. */
export function parseStatus(out: string) {
  const parts = out.split('\0')
  const files: SweepFile[] = []
  let tracked = 0
  let untracked = 0
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const p = rec.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i++ // the original path follows as its own entry
    if (xy === '??') untracked++
    else if (xy === '!!') continue
    else tracked++
    files.push({ code: xy === '??' ? '??' : xy.replace(/ /g, '') || xy.trim(), path: p })
  }
  return { files, tracked, untracked }
}

function oldestMtime(root: string, files: SweepFile[]): number | null {
  let min: number | null = null
  for (const f of files.slice(0, 40)) {
    try {
      const t = fs.statSync(path.join(root, f.path)).mtimeMs
      if (min == null || t < min) min = t
    } catch {
      /* deleted files have no mtime */
    }
  }
  return min
}

const PLAN_FILES = ['PLAN.md', 'ROADMAP.md', 'TODO.md', 'docs/PLAN.md', 'docs/ROADMAP.md']

export function nextPlanItem(root: string): { file: string; item: string } | null {
  for (const file of PLAN_FILES) {
    let txt: string
    try {
      const fp = path.join(root, file)
      const st = fs.statSync(fp)
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue
      txt = fs.readFileSync(fp, 'utf8')
    } catch {
      continue
    }
    const lines = txt.split(/\r?\n/)
    const clean = (s: string) =>
      s
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[ \]\s+)?/, '')
        .replace(/\*\*|__|`/g, '')
        .trim()
        .slice(0, 200)
    const box = lines.find((l) => /^\s*[-*+]\s+\[ \]\s+\S/.test(l))
    if (box) return { file, item: clean(box) }
    let inSection = false
    for (const l of lines) {
      const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l)
      if (h) {
        inSection = /known gaps|\bnext\b/i.test(h[1])
        continue
      }
      if (inSection && /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) && !/^\s*[-*+]\s+\[[xX]\]/.test(l)) return { file, item: clean(l) }
    }
  }
  return null
}

const FAILING = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

export function score(r: SweepRepo): void {
  let s = 0
  const a: string[] = []
  const now = Date.now()
  if (r.error) {
    s += 4
    a.push(`Couldn't read the repo: ${r.error}`)
  }
  if (r.ci && FAILING.has(r.ci.conclusion)) {
    s += 40
    a.push(`CI failing on ${r.defaultBranch ?? 'the default branch'} (${r.ci.workflowName || 'workflow'})`)
  }
  const changes = r.prs.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED')
  const waiting = r.prs.filter((p) => !p.isDraft && p.reviewDecision !== 'CHANGES_REQUESTED' && p.reviewDecision !== 'APPROVED')
  const approved = r.prs.filter((p) => !p.isDraft && p.reviewDecision === 'APPROVED')
  if (changes.length) {
    s += 18 * changes.length
    a.push(changes.length === 1 ? `PR #${changes[0].number} has changes requested` : `${changes.length} PRs have changes requested`)
  }
  if (waiting.length) {
    s += 10 * Math.min(waiting.length, 4)
    a.push(waiting.length === 1 ? `PR #${waiting[0].number} is waiting on review` : `${waiting.length} PRs waiting on review`)
  }
  if (approved.length) {
    s += 6 * approved.length
    a.push(approved.length === 1 ? `PR #${approved[0].number} is approved and ready to merge` : `${approved.length} approved PRs ready to merge`)
  }
  const dirty = r.uncommitted + r.untracked
  if (dirty) {
    const age = r.dirtySince ? now - r.dirtySince : 0
    if (age > 86_400_000) {
      const d = Math.floor(age / 86_400_000)
      s += 15 + Math.min(d, 10)
      a.push(`${dirty} uncommitted file${dirty === 1 ? '' : 's'}, untouched for ${d}d`)
    } else s += 3
  }
  if (r.behind > 0) {
    s += 10 + Math.min(r.behind, 10)
    a.push(`Behind ${r.upstream ?? 'upstream'} by ${r.behind} commit${r.behind === 1 ? '' : 's'}`)
  }
  if (r.ahead > 0) {
    s += 6 + Math.min(r.ahead, 6)
    a.push(`${r.ahead} commit${r.ahead === 1 ? '' : 's'} not pushed`)
  }
  if (!r.upstream && !r.detached && r.branch && r.defaultBranch && r.branch !== r.defaultBranch && r.remoteUrl) {
    s += 4
    a.push(`Branch ${r.branch} has no upstream`)
  }
  if (r.detached) {
    s += 4
    a.push('Detached HEAD')
  }
  if (r.staleCount) {
    s += Math.min(r.staleCount * 2, 10)
    a.push(`${r.staleCount} stale branch${r.staleCount === 1 ? '' : 'es'} (merged or 30d+ old)`)
  }
  if (r.stashes) {
    s += Math.min(r.stashes, 4)
    if (r.stashes >= 2) a.push(`${r.stashes} stashes`)
  }
  if (r.fetchError) a.push(`Fetch failed: ${r.fetchError}`)
  r.score = s
  r.attention = a
}

async function inspect(c: SweepCandidate, opts: { fetch: boolean; gh: string | null }): Promise<SweepRepo> {
  const t0 = Date.now()
  const { git: genv, gh: ghenv } = await envs()
  const cwd = c.path
  const g = (args: string[], timeout?: number) => exec('git', args, cwd, genv, timeout)
  const r: SweepRepo = {
    name: c.name,
    path: toRendererPath(c.path),
    known: c.known,
    branch: '',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    fetched: false,
    uncommitted: 0,
    untracked: 0,
    files: [],
    dirtySince: null,
    stashes: 0,
    lastCommit: null,
    daysSinceCommit: null,
    defaultBranch: null,
    staleBranches: [],
    staleCount: 0,
    slug: null,
    remoteUrl: null,
    gh: false,
    prs: [],
    ci: null,
    plan: null,
    score: 0,
    attention: [],
    ms: 0
  }
  try {
    if (!fs.existsSync(cwd)) throw new Error('Folder not found')

    // remote first: an opt-in fetch needs it, and gh needs the slug
    const remotes = await g(['remote'])
    const remoteNames = remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    const remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0]
    if (remote) {
      const u = await g(['remote', 'get-url', remote])
      r.remoteUrl = u.code === 0 ? u.stdout.trim() || null : null
      r.slug = parseSlug(r.remoteUrl)
    }
    if (opts.fetch && remote) {
      const f = await g(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote], FETCH_TIMEOUT)
      if (f.code === 0) r.fetched = true
      else r.fetchError = firstLine(f.stderr) || 'fetch failed'
    }

    const [head, up, status, stash, last, branches, originHead] = await Promise.all([
      g(['symbolic-ref', '--short', '-q', 'HEAD']),
      g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      g(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      g(['stash', 'list', '--format=%gd']),
      g(['log', '-1', '--format=%s%x1f%cr%x1f%an%x1f%ct']),
      g(['for-each-ref', '--format=%(refname:short)%1f%(committerdate:unix)', 'refs/heads']),
      remote ? g(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`]) : Promise.resolve<RunOut>({ code: 1, stdout: '', stderr: '' })
    ])

    if (status.code !== 0) throw new Error(firstLine(status.stderr) || 'git status failed')

    if (head.code === 0 && head.stdout.trim()) r.branch = head.stdout.trim()
    else {
      r.detached = true
      const sha = await g(['rev-parse', '--short', 'HEAD'])
      r.branch = sha.code === 0 ? sha.stdout.trim() : 'HEAD'
    }

    if (up.code === 0 && up.stdout.trim()) {
      r.upstream = up.stdout.trim()
      const ab = await g(['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      const m = /^(\d+)\s+(\d+)/.exec(ab.stdout.trim())
      if (m) {
        r.behind = Number(m[1])
        r.ahead = Number(m[2])
      }
    }

    const st = parseStatus(status.stdout)
    r.uncommitted = st.tracked
    r.untracked = st.untracked
    r.files = st.files.slice(0, 6)
    if (st.files.length) r.dirtySince = oldestMtime(cwd, st.files)

    r.stashes = stash.code === 0 ? stash.stdout.split('\n').filter((l) => l.trim()).length : 0

    if (last.code === 0 && last.stdout.trim()) {
      const [subject, relative, author, ct] = last.stdout.trim().split('\x1f')
      const time = Number(ct) * 1000
      r.lastCommit = { subject: subject ?? '', relative: relative ?? '', author: author ?? '', time }
      r.daysSinceCommit = time ? Math.floor((Date.now() - time) / 86_400_000) : null
    }

    // default branch: origin/HEAD, else main/master if they exist, else the current branch
    const local = branches.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, t] = l.split('\x1f')
        return { name, time: Number(t) * 1000 }
      })
    const names = new Set(local.map((b) => b.name))
    if (originHead.code === 0 && originHead.stdout.trim()) {
      const ref = originHead.stdout.trim()
      r.defaultBranch = ref.startsWith(`${remote}/`) ? ref.slice(remote!.length + 1) : ref
    }
    else r.defaultBranch = ['main', 'master', 'trunk', 'develop'].find((n) => names.has(n)) ?? (r.detached ? null : r.branch || null)

    if (r.defaultBranch && local.length > 1) {
      const base = names.has(r.defaultBranch) ? r.defaultBranch : remote ? `${remote}/${r.defaultBranch}` : r.defaultBranch
      const merged = await g(['branch', '--format=%(refname:short)', '--merged', base])
      const mergedSet = new Set(merged.code === 0 ? merged.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])
      const cutoff = Date.now() - 30 * 86_400_000
      const stale = local
        .filter((b) => b.name !== r.defaultBranch && b.name !== r.branch && (mergedSet.has(b.name) || (b.time && b.time < cutoff)))
        .sort((a, b) => a.time - b.time)
      r.staleCount = stale.length
      r.staleBranches = stale.slice(0, 8).map((b) => b.name)
    }

    r.plan = nextPlanItem(cwd)

    if (opts.gh && r.slug) {
      r.gh = true
      const [prs, runs] = await Promise.all([
        exec(opts.gh, ['pr', 'list', '--repo', r.slug, '--state', 'open', '--json', 'number,title,isDraft,reviewDecision,updatedAt,headRefName,author', '--limit', '10'], cwd, ghenv),
        r.defaultBranch
          ? exec(opts.gh, ['run', 'list', '--repo', r.slug, '--branch', r.defaultBranch, '--limit', '1', '--json', 'conclusion,status,workflowName,createdAt,url'], cwd, ghenv)
          : Promise.resolve<RunOut>({ code: 0, stdout: '[]', stderr: '' })
      ])
      const errs: string[] = []
      if (prs.code === 0) {
        try {
          const list = JSON.parse(prs.stdout || '[]') as any[]
          r.prs = list.map((p) => ({
            number: p.number,
            title: String(p.title ?? ''),
            isDraft: !!p.isDraft,
            reviewDecision: String(p.reviewDecision ?? ''),
            updatedAt: String(p.updatedAt ?? ''),
            headRefName: String(p.headRefName ?? ''),
            author: String(p.author?.login ?? ''),
            url: `https://github.com/${r.slug}/pull/${p.number}`
          }))
        } catch {
          errs.push('unreadable gh pr output')
        }
      } else errs.push(firstLine(prs.stderr))
      if (runs.code === 0) {
        try {
          const list = JSON.parse(runs.stdout || '[]') as any[]
          const x = list[0]
          if (x) r.ci = { conclusion: String(x.conclusion ?? ''), status: String(x.status ?? ''), workflowName: String(x.workflowName ?? ''), createdAt: String(x.createdAt ?? ''), url: String(x.url ?? '') }
        } catch {
          errs.push('unreadable gh run output')
        }
      } else errs.push(firstLine(runs.stderr))
      const e = errs.filter(Boolean)
      if (e.length) r.ghError = [...new Set(e)].join(' · ').slice(0, 240)
    }
  } catch (e: any) {
    r.error = String(e?.message ?? e).slice(0, 240)
  }
  score(r)
  r.ms = Date.now() - t0
  return r
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export async function runSweep(opts: { fetch?: boolean } = {}, onProgress?: (p: { done: number; total: number; repo: string }) => void): Promise<SweepResult> {
  const { roots, repos } = listRepos()
  const gh = await which('gh')
  let done = 0
  const total = repos.length
  onProgress?.({ done: 0, total, repo: '' })
  const results = await pool(repos, CONCURRENCY, async (c) => {
    const r = await inspect(c, { fetch: !!opts.fetch, gh })
    done++
    onProgress?.({ done, total, repo: r.name })
    return r
  })
  results.sort((a, b) => b.score - a.score || (b.lastCommit?.time ?? 0) - (a.lastCommit?.time ?? 0))
  return { at: Date.now(), fetch: !!opts.fetch, roots, ghAvailable: !!gh, repos: results }
}

let last: SweepResult | null = null
let inflight: { fetch: boolean; promise: Promise<SweepResult> } | null = null

export function register(ctx: MainContext) {
  ctx.ipc.handle('sweep:repos', () => {
    try {
      return listRepos()
    } catch (e: any) {
      return { roots: sweepRoots(), repos: [], error: String(e?.message ?? e) }
    }
  })
  ctx.ipc.handle('sweep:last', () => last)
  ctx.ipc.handle('sweep:run', async (_e, opts: { fetch?: boolean } = {}) => {
    const fetch = !!opts?.fetch
    // a second caller (background refresh, reopened panel) joins the running sweep
    if (inflight && (inflight.fetch || !fetch)) return inflight.promise
    const promise = runSweep({ fetch }, (p) => ctx.emit('sweep:progress', p))
      .then((res) => {
        last = res
        return res
      })
      .catch((e: any): SweepResult => ({ at: Date.now(), fetch, roots: sweepRoots(), ghAvailable: false, repos: [], error: String(e?.message ?? e) }))
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { fetch, promise }
    return promise
  })
}
