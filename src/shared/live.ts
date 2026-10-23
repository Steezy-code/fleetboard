// Live work, measured against the charter: how long a task has taken against its estimate, what a
// worker has changed before it reports, the choices it says it made, and whether the charter's own
// check is getting closer. Pure — the main process writes these onto the fleet state, the board and
// Oracle read them — and none of it asks a model anything.

import type { FleetTask } from './fleet'

// ---------------------------------------------------------------- time against an estimate

/** whole minutes in a span, rounded down: "12 min" means at least twelve */
export const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000))

/** "4 min", "1 h 5 min", "2 h" */
export function span(m: number): string {
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

export interface Timed {
  startedAt?: number
  endedAt?: number
  /** minutes the model expected it to take */
  estimate?: number
}

/** "12 min, est 5" while running, "took 12 min, est 5" once over, "est 5" before it starts; '' with nothing to say. */
export function elapsedLabel(t: Timed, now: number): string {
  const est = t.estimate ? `est ${span(t.estimate)}` : ''
  if (t.startedAt === undefined) return est
  const m = span(minutes((t.endedAt ?? now) - t.startedAt))
  const took = t.endedAt ? `took ${m}` : m
  return est ? `${took}, ${est}` : took
}

/** Past its estimate. It only ever colours the figure: stall detection does not read it (QUIET_MINUTES does that). */
export function overEstimate(t: Timed, now: number): boolean {
  return !!t.estimate && t.startedAt !== undefined && minutes((t.endedAt ?? now) - t.startedAt) > t.estimate
}

/** Far enough past its estimate to say so out loud: twice it, and at least five minutes over. */
export function farOver(t: Timed, now: number): boolean {
  if (!t.estimate || t.startedAt === undefined || t.endedAt !== undefined) return false
  const m = minutes(now - t.startedAt)
  return m >= 2 * t.estimate && m >= t.estimate + 5
}

/** An estimate as a model wrote it: whole minutes from one to ten hours, or none. */
export function estimateOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 1 || n > 600) return undefined
  return Math.round(n)
}

/**
 * Change a task's status, keeping its clock: it starts the first time it is taken up, stops when it is
 * handed in (review, done) or stuck (blocked), and runs again if it goes back to doing.
 */
export function stampTask(t: FleetTask, status: FleetTask['status'], now: number) {
  if (status === 'doing') {
    t.startedAt ??= now
    delete t.endedAt
  } else if (status !== 'todo' && t.startedAt !== undefined && t.endedAt === undefined) t.endedAt = now
  t.status = status
}

// ---------------------------------------------------------------- the work so far

/** What a worker's worktree holds that its branch does not yet: uncommitted, since a worker only commits when it reports. */
export interface LiveDiff {
  files: number
  add: number
  del: number
  at: number
}

/**
 * `git diff --numstat` → lines added / removed per file. A binary file says "-": it is a changed file
 * with no lines to count, so it counts as 0.
 */
export function numstat(out: string): { path: string; add: number; del: number }[] {
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3)
    .map(([add, del, ...rest]) => ({ path: rest.join('\t'), add: Number(add) || 0, del: Number(del) || 0 }))
}

/** `git diff --numstat HEAD` plus the untracked files (with their line counts, when they could be read). */
export function liveDiff(numstatOut: string, untracked: { path: string; lines: number }[], at: number): LiveDiff {
  const paths = new Set<string>()
  let add = 0
  let del = 0
  for (const f of numstat(numstatOut)) {
    paths.add(f.path)
    add += f.add
    del += f.del
  }
  for (const u of untracked) {
    if (paths.has(u.path)) continue
    paths.add(u.path)
    add += u.lines
  }
  return { files: paths.size, add, del, at }
}

export const sameDiff = (a: LiveDiff | undefined, b: LiveDiff | undefined) => !!a && !!b && a.files === b.files && a.add === b.add && a.del === b.del

/** "3 files +40 −2"; '' when nothing has changed yet. */
export const diffLabel = (d: LiveDiff | undefined) => (d?.files ? `${d.files} file${d.files === 1 ? '' : 's'} +${d.add} −${d.del}` : '')

// ---------------------------------------------------------------- the decision log

const HEAD = /^\s*(?:#+\s*)?decisions?\s*(?::\s*(.*))?$/i
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/

/**
 * The choices a worker says it made: the lines under "Decisions:" in its report, one per choice.
 * They are the part of a report worth reading afterwards, which is why workers are asked for them.
 */
export function decisionsOf(report: string | undefined): string[] {
  if (!report) return []
  const lines = report.split('\n')
  const at = lines.findIndex((l) => HEAD.test(l))
  if (at < 0) return []
  const out: string[] = []
  const inline = HEAD.exec(lines[at]!)?.[1]?.trim()
  if (inline) out.push(inline)
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) {
      if (out.length) break
      continue
    }
    // the next heading ends the list
    if (!BULLET.test(l) && /^\s*[A-Z][\w ]{0,30}:\s*$/.test(l)) break
    out.push(l.replace(BULLET, '').trim())
  }
  return out
    .filter(Boolean)
    .slice(0, 8)
    .map((d) => (d.length > 160 ? `${d.slice(0, 159).trimEnd()}…` : d))
}

// ---------------------------------------------------------------- the charter's check

export interface CheckRun {
  at: number
  /** exit code; null when it could not run, timed out or was stopped */
  code: number | null
  /** how many tests (or errors) it said failed, when it said */
  failing?: number
  /** the integration branch's commit it ran against */
  head?: string
  error?: string
  timedOut?: boolean
}

/** The charter's done-when, run in the Lead's worktree as the work lands. A progress field: the command itself stays the charter's. */
export interface DoneWhenCheck {
  /** the charter's doneWhen, verbatim, as it was when these runs were made */
  command: string
  /** the user switched it off */
  off?: boolean
  /** when the run in flight started */
  running?: number
  /** the last few, oldest first */
  runs: CheckRun[]
}

export const MAX_RUNS = 10

/** Tools a done-when names first that are certainly commands, whatever follows them. */
const RUNNERS = new Set(
  'npm pnpm yarn bun npx deno node python python3 py pytest tox nox uv poetry pip make just cargo go dotnet mvn gradle gradlew ant ruby rake bundle rspec php composer phpunit mix elixir swift xcodebuild flutter dart tsc eslint jest vitest mocha playwright test bash sh pwsh powershell cmd git ctest cmake ninja bazel'.split(
    ' '
  )
)

/**
 * Is this done-when a command, rather than a sentence? Only a command is run: the charter's model is
 * told to write one where it can and a sentence where it cannot, and a sentence fed to a shell is an
 * error on a loop at best. Conservative on purpose — a command this misses shows "not a command, not
 * run", and the user can rewrite it on the card.
 */
export function commandLike(doneWhen: string): boolean {
  const s = doneWhen.trim()
  if (!s || s.length > 300 || /[\r\n]/.test(s)) return false
  // "npm test passes", "build succeeds": a claim about a command, not the command
  if (/\s(pass(es)?|succeeds?|is green|works|exits? 0|returns? 0)\.?$/i.test(s)) return false
  const first = s.split(/\s+/)[0]!
  if (!/^(\.{0,2}[\\/])?[\w@.+-][\w@.+\\/-]*$/.test(first)) return false
  if (/[\\/]/.test(first) || RUNNERS.has(first.toLowerCase().replace(/\.(cmd|exe|bat|sh)$/, ''))) return true
  // an unknown first word: a command only with something only commands have
  return /^[a-z][\w.-]*$/.test(first) && /(\s-{1,2}\w|\s\.{0,2}\/|&&|\|\||[|;<>])/.test(s)
}

/**
 * How many failed, from the end of a test or check run's output, when it says. The last count wins:
 * a summary comes after the lines it sums up.
 */
export function failingCount(tail: string): number | undefined {
  let last: { at: number; n: number } | undefined
  const take = (re: RegExp) => {
    for (const m of tail.matchAll(re)) if (!last || m.index! >= last.at) last = { at: m.index!, n: Number(m[1]) }
  }
  // "3 failed", "3 failing", "2 failures", "Found 11 errors", "✖ 3 problems (3 errors"
  take(/\b(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?)\b/gi)
  // node:test and TAP: "ℹ fail 3", "# fail 3"
  take(/^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/gim)
  return last?.n
}

const describe = (r: CheckRun) =>
  r.code === 0 ? 'passing' : r.code === null ? (r.timedOut ? 'timed out' : r.error ? 'could not run' : 'stopped') : r.failing ? `${r.failing} failing` : 'failing'

/** "3 failing, down from 11" · "passing, from 11 failing" · "failing" · "running…" · "off" · "not a command, not run" */
export function checkTrend(c: DoneWhenCheck | undefined, doneWhen: string): string {
  if (!commandLike(doneWhen)) return 'not a command, not run'
  const runs = c?.runs ?? []
  const last = runs[runs.length - 1]
  const running = c?.running ? 'running…' : ''
  if (!last) return c?.off ? 'off' : running || 'not run yet'
  let now = describe(last)
  const base = runs.find((r) => r.failing !== undefined && r !== last)
  if (base?.failing !== undefined && last.code !== null) {
    if (last.code === 0 && base.failing > 0) now += `, from ${base.failing} failing`
    else if (last.failing !== undefined && last.failing !== base.failing) now += `, ${last.failing < base.failing ? 'down' : 'up'} from ${base.failing}`
  }
  if (c?.off) return `off · last ${now}`
  return running ? `${now} · ${running}` : now
}

/** Why a run may not start now, or true when it may. One rule for every trigger, so they cannot disagree. */
export function mayRun(o: {
  command: string
  off?: boolean
  running?: number
  leadWorking: boolean
  /** the Lead has an integration worktree of its own: the only place merged work lands, and the only place it runs */
  inWorktree: boolean
  head?: string
  lastHead?: string
  reason: 'start' | 'merge' | 'tick'
}): true | string {
  if (!commandLike(o.command)) return 'not a command'
  if (o.off) return 'switched off'
  // a long check must not overlap itself
  if (o.running) return 'already running'
  if (!o.leadWorking) return 'its lead is not working'
  if (!o.inWorktree) return 'no integration worktree'
  // the integration branch only moves when the Lead merges: the same commit gives the same answer
  if (o.reason === 'tick' && o.head && o.head === o.lastHead) return 'nothing new to check'
  return true
}

/** A finished run, appended and trimmed. */
export function withRun(c: DoneWhenCheck, run: CheckRun): DoneWhenCheck {
  const { running: _done, ...rest } = c
  return { ...rest, runs: [...c.runs, run].slice(-MAX_RUNS) }
}
