// CI watcher: GitHub Actions runs for the current branch and check results for open PRs, through `gh`.
// The renderer polls ci:status (faster while something is running) and asks for ci:failedLog when an
// agent is sent to fix a failure. ci:prFeedback reads reviewers' comments on open PRs (one GraphQL
// call), so new ones can go back to the agent that made the PR.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { MainContext } from './context'
import { loginEnv, which } from './env'
import { stripAnsi } from '@shared/ansi'

export type CiState = 'passing' | 'failing' | 'running' | 'none'

export interface CiRun {
  id: number
  workflow: string
  title: string
  branch: string
  sha: string
  event: string
  state: CiState
  /** GitHub's own words: success, failure, cancelled, in_progress, queued… */
  detail: string
  createdAt: string
  url: string
}

export interface CiCheck {
  name: string
  workflow: string
  state: CiState
  /** the Actions run behind this check, when it is one (for its log) */
  runId: number | null
  url: string
}

export interface CiPr {
  number: number
  title: string
  branch: string
  url: string
  isDraft: boolean
  state: CiState
  checks: CiCheck[]
}

export type CiStatus =
  | { ok: true; at: number; branch: string; slug: string; runs: CiRun[]; prs: CiPr[] }
  | { ok: false; at: number; error: string; reason: 'no-gh' | 'no-auth' | 'no-remote' | 'not-repo' | 'error' }

interface Out {
  code: number
  stdout: string
  stderr: string
}

function exec(bin: string, args: string[], cwd: string, env: Record<string, string>, timeout = 20000): Promise<Out> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? String(err.message ?? err) : '') })
    })
  })
}

let envCache: Record<string, string> | null = null
async function ghEnv() {
  envCache ??= { ...(await loginEnv()), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  return envCache
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

/** A run's status + conclusion as one state. Cancelled and skipped runs don't count as failures. */
export function runState(status: string, conclusion: string | null | undefined): CiState {
  const s = (status || '').toLowerCase()
  if (s && s !== 'completed') return 'running'
  const c = (conclusion || '').toLowerCase()
  if (['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].includes(c)) return 'failing'
  if (['success', 'neutral'].includes(c)) return 'passing'
  return 'none'
}

/** One entry per check name (GitHub lists reruns too); the latest wins. */
export function summarizeChecks(rollup: any[]): CiCheck[] {
  const latest = new Map<string, { at: string; check: CiCheck }>()
  for (const c of rollup ?? []) {
    let check: CiCheck
    let at: string
    if (c.__typename === 'StatusContext') {
      const st = String(c.state || '').toUpperCase()
      check = {
        name: c.context || 'status',
        workflow: '',
        state: st === 'SUCCESS' ? 'passing' : st === 'PENDING' || st === 'EXPECTED' ? 'running' : st ? 'failing' : 'none',
        runId: null,
        url: c.targetUrl || ''
      }
      at = c.startedAt || c.createdAt || ''
    } else {
      const url = c.detailsUrl || ''
      const m = /\/actions\/runs\/(\d+)/.exec(url)
      check = { name: c.name || 'check', workflow: c.workflowName || '', state: runState(c.status, c.conclusion), runId: m ? Number(m[1]) : null, url }
      at = c.startedAt || c.completedAt || ''
    }
    const key = `${check.workflow}/${check.name}`
    const prev = latest.get(key)
    if (!prev || at >= prev.at) latest.set(key, { at, check })
  }
  return [...latest.values()].map((v) => v.check)
}

export function overall(states: CiState[]): CiState {
  if (states.includes('failing')) return 'failing'
  if (states.includes('running')) return 'running'
  if (states.includes('passing')) return 'passing'
  return 'none'
}

async function status(cwd: string): Promise<CiStatus> {
  const at = Date.now()
  if (typeof cwd !== 'string' || !fs.existsSync(cwd)) return { ok: false, at, error: 'Folder not found', reason: 'not-repo' }
  const gh = await which('gh')
  if (!gh) return { ok: false, at, error: 'Install the GitHub CLI (gh) to watch CI.', reason: 'no-gh' }
  const env = await ghEnv()
  const b = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, env, 5000)
  if (b.code !== 0) return { ok: false, at, error: 'Not a git repository', reason: 'not-repo' }
  const branch = b.stdout.trim()
  const repo = await exec(gh, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd, env)
  if (repo.code !== 0) {
    const msg = firstLine(repo.stderr)
    if (/auth login|not logged/i.test(msg)) return { ok: false, at, error: 'Sign in with `gh auth login` to watch CI.', reason: 'no-auth' }
    return { ok: false, at, error: /no git remote|none of the git remotes|not a git/i.test(msg) ? 'This repo has no GitHub remote.' : msg || 'gh failed', reason: 'no-remote' }
  }
  const slug = repo.stdout.trim()
  const [runsOut, prsOut] = await Promise.all([
    branch === 'HEAD'
      ? Promise.resolve({ code: 0, stdout: '[]', stderr: '' })
      : exec(gh, ['run', 'list', '--branch', branch, '--limit', '20', '--json', 'databaseId,status,conclusion,workflowName,displayTitle,headBranch,headSha,event,createdAt,url'], cwd, env),
    exec(gh, ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url,isDraft,statusCheckRollup'], cwd, env)
  ])
  if (runsOut.code !== 0) return { ok: false, at, error: firstLine(runsOut.stderr) || 'gh run list failed', reason: 'error' }
  if (prsOut.code !== 0) return { ok: false, at, error: firstLine(prsOut.stderr) || 'gh pr list failed', reason: 'error' }
  let rawRuns: any[]
  let rawPrs: any[]
  try {
    rawRuns = JSON.parse(runsOut.stdout || '[]')
    rawPrs = JSON.parse(prsOut.stdout || '[]')
  } catch {
    return { ok: false, at, error: 'Unexpected gh output', reason: 'error' }
  }
  // the latest run of each workflow on this branch
  const byWorkflow = new Map<string, CiRun>()
  for (const r of rawRuns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    if (byWorkflow.has(r.workflowName)) continue
    byWorkflow.set(r.workflowName, {
      id: r.databaseId,
      workflow: r.workflowName,
      title: r.displayTitle,
      branch: r.headBranch,
      sha: r.headSha,
      event: r.event,
      state: runState(r.status, r.conclusion),
      detail: r.status === 'completed' ? r.conclusion || 'completed' : r.status,
      createdAt: r.createdAt,
      url: r.url
    })
  }
  const prs: CiPr[] = rawPrs.map((p) => {
    const checks = summarizeChecks(p.statusCheckRollup)
    return { number: p.number, title: p.title, branch: p.headRefName, url: p.url, isDraft: !!p.isDraft, checks, state: overall(checks.map((c) => c.state)) }
  })
  return { ok: true, at, branch, slug, runs: [...byWorkflow.values()], prs }
}

/** Agents start their replies on a PR with this, so their own words are never sent back to them. */
export const AGENT_MARK = '🤖'

export interface PrComment {
  /** stable across polls: kind + GitHub's id */
  id: string
  kind: 'comment' | 'review' | 'inline'
  author: string
  body: string
  createdAt: string
  url: string
  /** a review's verdict: CHANGES_REQUESTED, COMMENTED, APPROVED */
  state?: string
  /**
   * How GitHub says the author relates to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR,
   * FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN or NONE. Comments are routed straight into an
   * agent working in the user's checkout, so on a public repo this decides whose words get to do
   * that (see trustedAuthor in renderer/src/workbench/prFeedback.ts).
   */
  association?: string
  path?: string
  line?: number | null
}

export interface PrFeedback {
  number: number
  title: string
  branch: string
  url: string
  author: string
  comments: PrComment[]
}

export type PrFeedbackResult = { ok: true; at: number; viewer: string; prs: PrFeedback[] } | { ok: false; at: number; error: string }

const FEEDBACK_QUERY = `query($owner:String!,$name:String!){ viewer{login} repository(owner:$owner,name:$name){ pullRequests(states:OPEN, first:20, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{
  number title headRefName url author{login}
  comments(last:30){nodes{databaseId author{login __typename} authorAssociation body createdAt url}}
  reviews(last:30){nodes{databaseId author{login __typename} authorAssociation body state submittedAt url}}
  reviewThreads(last:50){nodes{isResolved isOutdated path line comments(first:20){nodes{databaseId author{login __typename} authorAssociation body createdAt url}}}}
} } } }`

/**
 * What a reviewer asked for, from one PR's GraphQL node: issue comments, review summaries and inline
 * comments on unresolved threads. Left out: empty bodies (a bare approval), bots' plain comments
 * (deploy previews, coverage) but not their reviews, and anything an agent wrote (AGENT_MARK).
 */
export function feedbackOf(pr: any): PrComment[] {
  const out: PrComment[] = []
  const keep = (body: string, author: any, isReview: boolean) => {
    const b = String(body ?? '').trim()
    if (!b || b.startsWith(AGENT_MARK)) return false
    if (author?.__typename === 'Bot' && !isReview) return false
    return true
  }
  for (const c of pr.comments?.nodes ?? [])
    if (keep(c.body, c.author, false)) out.push({ id: `c${c.databaseId}`, kind: 'comment', author: c.author?.login ?? 'someone', body: c.body.trim(), createdAt: c.createdAt, url: c.url, association: c.authorAssociation })
  for (const r of pr.reviews?.nodes ?? [])
    if (keep(r.body, r.author, true)) out.push({ id: `r${r.databaseId}`, kind: 'review', author: r.author?.login ?? 'someone', body: r.body.trim(), createdAt: r.submittedAt, url: r.url, state: r.state, association: r.authorAssociation })
  for (const t of pr.reviewThreads?.nodes ?? []) {
    if (t.isResolved) continue
    for (const c of t.comments?.nodes ?? [])
      if (keep(c.body, c.author, true))
        out.push({ id: `i${c.databaseId}`, kind: 'inline', author: c.author?.login ?? 'someone', body: c.body.trim(), createdAt: c.createdAt, url: c.url, path: t.path, line: t.line ?? null, association: c.authorAssociation })
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

async function prFeedback(cwd: string): Promise<PrFeedbackResult> {
  const at = Date.now()
  if (typeof cwd !== 'string' || !fs.existsSync(cwd)) return { ok: false, at, error: 'Folder not found' }
  const gh = await which('gh')
  if (!gh) return { ok: false, at, error: 'GitHub CLI (gh) is not installed' }
  const env = await ghEnv()
  const repo = await exec(gh, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd, env)
  if (repo.code !== 0) return { ok: false, at, error: firstLine(repo.stderr) || 'gh failed' }
  const [owner, name] = repo.stdout.trim().split('/')
  const r = await exec(gh, ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${FEEDBACK_QUERY}`], cwd, env, 30000)
  if (r.code !== 0) return { ok: false, at, error: firstLine(r.stderr) || 'gh api failed' }
  try {
    const d = JSON.parse(r.stdout).data
    const prs: PrFeedback[] = (d.repository?.pullRequests?.nodes ?? []).map((p: any) => ({
      number: p.number,
      title: p.title,
      branch: p.headRefName,
      url: p.url,
      author: p.author?.login ?? '',
      comments: feedbackOf(p)
    }))
    return { ok: true, at, viewer: d.viewer?.login ?? '', prs }
  } catch {
    return { ok: false, at, error: 'Unexpected gh output' }
  }
}

/** The failed steps' log, cleaned up and cut to where it failed (the cleanup steps after it are noise). */
export function cleanLog(raw: string, maxLines = 160): string {
  let lines = stripAnsi(raw)
    .split('\n')
    .map((l) => {
      // "job<TAB>step<TAB>2026-10-19T22:01:01.1234567Z text"
      const parts = l.split('\t')
      const text = parts.length >= 3 ? parts.slice(2).join('\t') : l
      return text.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/^##\[(group|endgroup)\]/, '')
    })
    .filter((l) => l.trim())
  // gh can't always name the steps, but the runner marks the failure itself
  const lastError = lines.findLastIndex((l) => l.startsWith('##[error]'))
  if (lastError >= 0) lines = lines.slice(0, lastError + 1)
  const tail = lines.slice(-maxLines)
  return (lines.length > maxLines ? `… (${lines.length - maxLines} earlier lines cut)\n` : '') + tail.join('\n')
}

async function failedLog(cwd: string, runId: number): Promise<{ ok: true; log: string } | { ok: false; error: string }> {
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, error: 'Bad run id' }
  const gh = await which('gh')
  if (!gh) return { ok: false, error: 'GitHub CLI (gh) is not installed' }
  const r = await exec(gh, ['run', 'view', String(runId), '--log-failed'], cwd, await ghEnv(), 45000)
  if (r.code !== 0) return { ok: false, error: firstLine(r.stderr) || 'gh run view failed' }
  return { ok: true, log: cleanLog(r.stdout) }
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('ci:status', async (_e, cwd: string) => {
    try {
      return await status(cwd)
    } catch (e: any) {
      return { ok: false, at: Date.now(), error: e?.message ?? String(e), reason: 'error' } satisfies CiStatus
    }
  })
  ctx.ipc.handle('ci:prFeedback', async (_e, cwd: string) => {
    try {
      return await prFeedback(cwd)
    } catch (e: any) {
      return { ok: false, at: Date.now(), error: e?.message ?? String(e) } satisfies PrFeedbackResult
    }
  })
  ctx.ipc.handle('ci:failedLog', async (_e, cwd: string, runId: number) => {
    try {
      return await failedLog(cwd, runId)
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })
}
