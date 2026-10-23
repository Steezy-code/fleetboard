import fs from 'node:fs'
import path from 'node:path'
import type { MainContext } from './context'
import { which } from './env'
import { readRegularFile } from './paths'
import { allowed } from './roots'
import { ghEnv, run, git as runGit, type GitOpts, type RunOut } from './run'

// Git card / GitHub panel IPC. Every handler resolves to { ok: true, ... } or { ok: false, error }.

export type GitResult<T = {}> = ({ ok: true } & T) | { ok: false; error: string }

export interface GitFile {
  path: string
  /** previous path for renames / copies */
  from?: string
  /** display code: M A D R C U ? */
  code: string
  /** raw XY from porcelain v2 (index, worktree) */
  x: string
  y: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitStatus {
  branch: string
  detached: boolean
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
  /** repo top level */
  root: string
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  date: string
  time: number
  pushed: boolean
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
  date: string
  remote: boolean
}

export interface GitRemote {
  url: string | null
  owner: string | null
  repo: string | null
  /** owner/repo when it can be parsed, else the folder name */
  slug: string
  /** https page for the repo (GitHub, GitLab, ...) */
  web: string | null
}

export interface GitPr {
  number: number
  title: string
  headRefName: string
  url: string
  isDraft: boolean
  author: { login: string }
  updatedAt: string
}

// a diff of a large working tree is the reason for the generous buffer
const git = (cwd: string, args: string[], opts: GitOpts = {}) => runGit(cwd, args, { maxBuffer: 64 * 1024 * 1024, ...opts })

/** The useful part of git's stderr (drops hints and blank lines). */
function cleanErr(r: RunOut, fallback = 'git failed') {
  if (/nothing to commit|no changes added to commit/i.test(r.stdout + r.stderr)) return 'Nothing to commit'
  const lines = (r.stderr || r.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
  const msg = lines.join(' · ').replace(/^(fatal|error): /i, '')
  return msg.length > 400 ? msg.slice(0, 400) + '…' : msg || fallback
}

const fail = (error: string) => ({ ok: false as const, error })

/**
 * A folder git may run in: one that exists, inside the folders Fleetboard may use (roots.ts), as the
 * filesystem handlers already require. git here carries the user's credentials and can push, commit
 * and check out, and a git card's folder comes from the board file.
 */
function validCwd(cwd: string) {
  return typeof cwd === 'string' && cwd.length > 0 && allowed(cwd, 'git') && fs.existsSync(cwd)
}

const CODE_FOR: Record<string, string> = { M: 'M', T: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U' }

function displayCode(x: string, y: string) {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U'
  // prefer the index change for adds/renames, the worktree change otherwise
  if (x === 'R' || x === 'C' || x === 'A') return CODE_FOR[x] ?? 'M'
  if (y !== '.') return CODE_FOR[y] ?? 'M'
  return CODE_FOR[x] ?? 'M'
}

export function parseStatus(out: string, root: string): GitStatus {
  const st: GitStatus = { branch: '', detached: false, oid: null, upstream: null, ahead: 0, behind: 0, files: [], root }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') st.oid = val === '(initial)' ? null : val
      else if (key === 'branch.head') {
        st.detached = val === '(detached)'
        st.branch = st.detached ? (st.oid ? st.oid.slice(0, 7) : 'HEAD') : val
      } else if (key === 'branch.upstream') st.upstream = val
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val)
        if (m) {
          st.ahead = Number(m[1])
          st.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = rec[0]
    if (kind === '?') {
      st.files.push({ path: rec.slice(2), code: '?', x: '?', y: '?', staged: false, unstaged: true, untracked: true })
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      const fields = rec.split(' ')
      // The XY field, which every kind of record has second. Reading fields[1][0] of a record
      // without one threw, and took the status read for the whole repo with it. No git this parser
      // is given emits such a record — a truncated or timed-out read exits non-zero and status()
      // turns back before here — so this is the next porcelain version, or a byte of something
      // else, costing one file instead of the panel.
      const xy = fields[1] ?? ''
      if (xy.length < 2) continue
      const x = xy.charAt(0)
      const y = xy.charAt(1)
      // path is everything after the fixed number of fields
      const fixed = kind === '1' ? 8 : kind === '2' ? 9 : 10
      const p = fields.slice(fixed).join(' ')
      const file: GitFile = { path: p, code: displayCode(x, y), x, y, staged: x !== '.', unstaged: y !== '.', untracked: false }
      if (kind === '2') file.from = parts[++i]
      if (kind === 'u') file.code = 'U'
      st.files.push(file)
    }
    if (st.files.length >= 3000) break
  }
  return st
}

async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 5000 })
  return r.code === 0 ? r.stdout.trim() : null
}

async function status(cwd: string): Promise<GitResult<{ status: GitStatus }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const root = await repoRoot(cwd)
  if (!root) return fail('Not a git repository')
  const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeout: 15000 })
  if (r.code !== 0) return fail(cleanErr(r))
  return { ok: true, status: parseStatus(r.stdout, root) }
}

async function hasUpstream(cwd: string) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 5000 })
  return r.code === 0 ? r.stdout.trim() : null
}

async function log(cwd: string, n = 20): Promise<GitResult<{ commits: GitCommit[] }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { timeout: 5000 })
  if (head.code !== 0) return { ok: true, commits: [] }
  const r = await git(cwd, ['log', `-n${Math.max(1, Math.min(500, n))}`, '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%at%x1e'])
  if (r.code !== 0) return fail(cleanErr(r))
  const up = await hasUpstream(cwd)
  let unpushed = new Set<string>()
  let anyRemote = !!up
  if (up) {
    const u = await git(cwd, ['rev-list', '@{u}..HEAD'])
    unpushed = new Set(u.stdout.split('\n').filter(Boolean))
  } else {
    // no upstream: anything not on any remote ref is unpushed
    const u = await git(cwd, ['rev-list', 'HEAD', '--not', '--remotes', `-n${n}`])
    const remotes = await git(cwd, ['remote'])
    anyRemote = remotes.stdout.trim().length > 0
    unpushed = new Set(u.stdout.split('\n').filter(Boolean))
  }
  const commits = r.stdout
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash = '', short = '', subject = '', author = '', date, at] = rec.split('\x1f')
      return { hash, short, subject, author, date: shortRel(date), time: Number(at) * 1000, pushed: anyRemote && !unpushed.has(hash) }
    })
  return { ok: true, commits }
}

/** "3 hours ago" → "3h ago". Takes a missing date, which is what its callers can hand it. */
function shortRel(s: string | undefined) {
  return (s ?? '')
    .replace(/(\d+) seconds? ago/, '$1s ago')
    .replace(/(\d+) minutes? ago/, '$1m ago')
    .replace(/(\d+) hours? ago/, '$1h ago')
    .replace(/(\d+) days? ago/, '$1d ago')
    .replace(/(\d+) weeks? ago/, '$1w ago')
    .replace(/(\d+) months? ago/, '$1mo ago')
    .replace(/(\d+) years?, (\d+) months? ago/, '$1y $2mo ago')
    .replace(/(\d+) years? ago/, '$1y ago')
}

const MAX_DIFF = 400 * 1024

async function diff(cwd: string, file: string, opts: { untracked?: boolean; staged?: boolean } = {}): Promise<GitResult<{ diff: string; binary?: boolean; truncated?: boolean }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const root = (await repoRoot(cwd)) ?? cwd
  const abs = path.resolve(root, file)
  if (opts.untracked) {
    try {
      const st = fs.statSync(abs)
      if (st.isDirectory()) {
        const r = await git(root, ['ls-files', '--others', '--exclude-standard', '--', file])
        const files = r.stdout.split('\n').filter(Boolean)
        return { ok: true, diff: `New folder · ${files.length} file${files.length === 1 ? '' : 's'}\n` + files.map((f) => '+ ' + f).join('\n') }
      }
      if (st.size > MAX_DIFF) return { ok: true, diff: `New file · ${(st.size / 1024).toFixed(0)} KB (too large to preview)`, truncated: true }
      const buf = readRegularFile(abs, MAX_DIFF)
      if (buf.subarray(0, 8000).includes(0)) return { ok: true, diff: 'New binary file', binary: true }
      const lines = buf.toString('utf8').split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      return { ok: true, diff: `@@ -0,0 +1,${lines.length} @@ new file\n` + lines.map((l) => '+' + l).join('\n') }
    } catch (e: any) {
      return fail(e?.message ?? 'Cannot read file')
    }
  }
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
  const against = opts.staged || !hasHead ? ['--cached'] : ['HEAD']
  const r = await git(root, ['diff', ...against, '--no-color', '-M', '--', file], { gitOpts: ['--literal-pathspecs'] })
  if (r.code !== 0) return fail(cleanErr(r))
  let out = r.stdout
  const binary = /^Binary files .* differ$/m.test(out)
  let truncated = false
  if (out.length > MAX_DIFF) {
    out = out.slice(0, MAX_DIFF)
    truncated = true
  }
  // strip the "diff --git / index" preamble; keep from the first hunk
  const at = out.indexOf('\n@@')
  if (at >= 0) out = out.slice(at + 1)
  return { ok: true, diff: out || 'No textual changes', binary, truncated }
}

async function show(cwd: string, hash: string): Promise<GitResult<{ diff: string }>> {
  if (!/^([0-9a-f]{4,64}|HEAD(~\d+)?)$/i.test(hash)) return fail('Bad commit id')
  const r = await git(cwd, ['show', '--no-color', '--stat', '--patch', '--format=%h %s%n%an · %ar%n', hash])
  if (r.code !== 0) return fail(cleanErr(r))
  return { ok: true, diff: r.stdout.length > MAX_DIFF ? r.stdout.slice(0, MAX_DIFF) : r.stdout }
}

/**
 * `files` null commits everything, which the Git card does when every file is ticked. `shown` is the
 * list that was on screen then: an agent may have written more files since (a new .env.local), and
 * "everything" must not grow past what the user looked at, so the commit is refused if it would.
 */
async function commit(cwd: string, message: string, files?: { path: string; from?: string }[] | null, shown?: string[]): Promise<GitResult<{ hash: string; count: number }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const msg = (message ?? '').trim()
  if (!msg) return fail('Write a commit message first')
  const root = (await repoRoot(cwd)) ?? cwd
  let count = 0
  if (files && files.length) {
    const addPaths = files.map((f) => f.path)
    // literal: a path like app/[id]/page.tsx is a file name, not a glob that could stage app/i/page.tsx
    const add = await git(root, ['--literal-pathspecs', 'add', '-A', '--', ...addPaths])
    if (add.code !== 0) return fail(cleanErr(add, 'git add failed'))
    const spec = [...new Set(files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))]
    const r = await git(root, ['--literal-pathspecs', 'commit', '-F', '-', '--', ...spec], { input: msg, timeout: 60000 })
    if (r.code !== 0) return fail(cleanErr(r, 'git commit failed'))
    count = files.length
  } else {
    if (Array.isArray(shown)) {
      const now = await status(cwd)
      if (!now.ok) return now
      const seen = new Set(shown)
      const added = now.status.files.map((f) => f.path).filter((p) => !seen.has(p))
      if (added.length) return fail(`${added.length === 1 ? `${added[0]} changed` : `${added.length} more files changed`} since you looked. Check the list and commit again.`)
    }
    const add = await git(root, ['add', '-A'])
    if (add.code !== 0) return fail(cleanErr(add, 'git add failed'))
    const r = await git(root, ['commit', '-F', '-'], { input: msg, timeout: 60000 })
    if (r.code !== 0) return fail(cleanErr(r, 'git commit failed'))
  }
  const h = await git(root, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, hash: h.stdout.trim(), count }
}

async function push(cwd: string): Promise<GitResult<{ output: string; setUpstream: boolean }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const up = await hasUpstream(cwd)
  if (up) {
    const r = await git(cwd, ['push'], { timeout: 120000 })
    if (r.code !== 0) return fail(cleanErr(r, 'git push failed'))
    return { ok: true, output: r.stderr.trim(), setUpstream: false }
  }
  const remotes = (await git(cwd, ['remote'])).stdout.split('\n').filter(Boolean)
  if (!remotes.length) return fail('No remote configured — add one with `git remote add origin <url>`')
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin'
  const r = await git(cwd, ['push', '-u', remote, 'HEAD'], { timeout: 120000 })
  if (r.code !== 0) return fail(cleanErr(r, 'git push failed'))
  return { ok: true, output: r.stderr.trim(), setUpstream: true }
}

async function pull(cwd: string): Promise<GitResult<{ output: string }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  if (!(await hasUpstream(cwd))) return fail('This branch has no upstream to pull from')
  // fetch + fast-forward rather than `git pull`: a user's pull.rebase=true would turn the pull into a
  // rebase, which refuses to run with any uncommitted change. A fast-forward keeps unrelated local
  // edits and still refuses (safely) when the branches have diverged.
  const f = await git(cwd, ['fetch', '--prune'], { timeout: 120000 })
  if (f.code !== 0) return fail(cleanErr(f, 'git fetch failed'))
  const r = await git(cwd, ['merge', '--ff-only', '@{u}'], { timeout: 60000 })
  if (r.code !== 0) {
    const msg = cleanErr(r, 'git pull failed')
    return fail(/not possible to fast-forward|diverg/i.test(msg) ? 'Your branch and its upstream have diverged; merge or rebase in a console.' : msg)
  }
  return { ok: true, output: r.stdout.trim() }
}

async function fetch(cwd: string): Promise<GitResult<{ output: string }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const r = await git(cwd, ['fetch', '--prune'], { timeout: 120000 })
  if (r.code !== 0) return fail(cleanErr(r, 'git fetch failed'))
  return { ok: true, output: r.stderr.trim() }
}

async function branches(cwd: string, all = false): Promise<GitResult<{ branches: GitBranch[] }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const args = ['branch', '--sort=-committerdate', '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:relative)']
  if (all) args.push('-a')
  const r = await git(cwd, args)
  if (r.code !== 0) return fail(cleanErr(r))
  const list = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref = '', head, upstream, date] = l.split('\x1f')
      const remote = ref.startsWith('refs/remotes/')
      const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
      return { name, current: head === '*', upstream: upstream || null, date: shortRel(date), remote }
    })
    .filter((b) => !b.name.endsWith('/HEAD'))
  return { ok: true, branches: list }
}

async function checkout(cwd: string, branch: string, create = false): Promise<GitResult> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const name = (branch ?? '').trim()
  if (!name || name.startsWith('-')) return fail('Bad branch name')
  // "--": without it git reads a name that happens to match a path as a pathspec, so a checkout of
  // "." or "src" quietly threw away the uncommitted work there instead of switching branch. Real
  // branches and a bare commit id (a detached HEAD, as remote branches use) are unaffected.
  const r = create ? await git(cwd, ['checkout', '-b', name, '--']) : await git(cwd, ['checkout', name, '--'])
  if (r.code !== 0) return fail(cleanErr(r, 'git checkout failed'))
  return { ok: true }
}

function parseRemoteUrl(url: string): { owner: string; repo: string; web: string } | null {
  // git@github.com:owner/repo.git · ssh://git@host/owner/repo · https://host/owner/repo(.git)
  let host = ''
  let p = ''
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url)
  if (scp) {
    const [, scpHost = '', scpPath = ''] = scp
    host = scpHost
    p = scpPath
  } else {
    try {
      const u = new URL(url)
      host = u.hostname
      p = u.pathname
    } catch {
      return null
    }
  }
  p = p.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const segs = p.split('/')
  if (segs.length < 2) return null
  const repo = segs[segs.length - 1]
  const owner = segs.slice(0, -1).join('/')
  if (!repo) return null
  return { owner, repo, web: `https://${host}/${owner}/${repo}` }
}

async function remote(cwd: string): Promise<GitResult<{ remote: GitRemote }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const root = (await repoRoot(cwd)) ?? cwd
  let r = await git(cwd, ['remote', 'get-url', 'origin'])
  if (r.code !== 0) {
    const first = (await git(cwd, ['remote'])).stdout.split('\n').filter(Boolean)[0]
    if (first) r = await git(cwd, ['remote', 'get-url', first])
  }
  const url = r.code === 0 ? r.stdout.trim() : null
  const parsed = url ? parseRemoteUrl(url) : null
  return {
    ok: true,
    remote: {
      url,
      owner: parsed?.owner ?? null,
      repo: parsed?.repo ?? null,
      slug: parsed ? `${parsed.owner}/${parsed.repo}` : path.basename(root),
      web: parsed?.web ?? null
    }
  }
}

async function prList(cwd: string): Promise<GitResult<{ prs: GitPr[] }>> {
  if (!validCwd(cwd)) return fail('Folder not found')
  const gh = await which('gh')
  if (!gh) return fail('GitHub CLI (gh) is not installed')
  const r = await run(gh, ['pr', 'list', '--limit', '20', '--json', 'number,title,headRefName,url,isDraft,author,updatedAt'], {
    cwd,
    env: await ghEnv(),
    maxBuffer: 8 * 1024 * 1024
  })
  if (r.code !== 0) return fail(r.stderr.trim().split('\n')[0] || 'gh failed')
  try {
    return { ok: true, prs: JSON.parse(r.stdout) }
  } catch {
    return fail('Unexpected gh output')
  }
}

/** Never let an exception escape as a rejected invoke: the renderer always gets { ok:false, error }. */
const safe =
  <A extends any[], R>(fn: (...a: A) => Promise<R>) =>
  async (_e: unknown, ...a: A): Promise<R | { ok: false; error: string }> => {
    try {
      return await fn(...a)
    } catch (e: any) {
      return fail(e?.message ?? String(e))
    }
  }

export function register(ctx: MainContext) {
  const { ipc } = ctx
  ipc.handle('git:isRepo', async (_e, cwd: string) => (validCwd(cwd) ? (await repoRoot(cwd)) !== null : false))
  ipc.handle(
    'git:init',
    safe(async (cwd: string) => {
      if (!validCwd(cwd)) return fail('Folder not found')
      const r = await git(cwd, ['init'])
      return r.code === 0 ? { ok: true as const } : fail(cleanErr(r))
    })
  )
  ipc.handle('git:status', safe(status))
  ipc.handle('git:log', safe(log))
  ipc.handle('git:diff', safe(diff))
  ipc.handle('git:show', safe(show))
  ipc.handle('git:commit', safe(commit))
  ipc.handle('git:push', safe(push))
  ipc.handle('git:pull', safe(pull))
  ipc.handle('git:fetch', safe(fetch))
  ipc.handle('git:branches', safe(branches))
  ipc.handle('git:checkout', safe(checkout))
  ipc.handle('git:remote', safe(remote))
  ipc.handle('git:prList', safe(prList))
}
