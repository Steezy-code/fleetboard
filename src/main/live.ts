import fs from 'node:fs'
import path from 'node:path'
import { HEAVY_DIRS, LINKED_DIRS, type FleetMember, type FleetState } from '@shared/fleet'
import { type CheckRun, failingCount, liveDiff, mayRun, sameDiff, withRun } from '@shared/live'
import type { MainContext } from './context'
import { runGoalCheck } from './goal'
import { readRegularText } from './paths'
import { git } from './run'

// Live work, sampled without a model: when each member last printed (a stall is silence), what each
// worker has changed in its worktree before it reports, and the charter's done-when run in the Lead's
// integration worktree as merged work lands there. What it finds is written to the fleet state as
// progress — never into the charter, whose fields are the user's.

interface Live {
  ctx: MainContext
  teams: () => Iterable<FleetState>
  changed: (s: FleetState) => void
  /** where team worktrees live: a Lead outside it has no integration worktree of its own */
  trees: string
}

let live: Live | null = null
const ticks: NodeJS.Timeout[] = []

const OUTPUT_TICK_MS = 15_000
/** an output time this much newer is worth writing: a chatty console must not rewrite the fleet file every tick */
const OUTPUT_STEP_MS = 30_000
const DIFF_TICK_MS = 15_000
/** the done-when only runs again on this tick if the integration branch moved (mayRun) */
const CHECK_TICK_MS = 5 * 60_000
const CHECK_TIMEOUT_MS = 10 * 60_000

/** Record a newer output time when it has moved enough to matter. True when it changed. */
export function stampOutput(m: FleetMember, at: number | null): boolean {
  if (at === null || (m.lastOutputAt !== undefined && at - m.lastOutputAt < OUTPUT_STEP_MS)) return false
  m.lastOutputAt = at
  return true
}

const busy = (m: FleetMember) => m.status === 'working' || m.status === 'starting'

/**
 * Silence is only counted from when this run of the app started watching. An output time saved
 * before a restart says nothing about the time since — every member would come back "silent" for
 * the length of the outage — so each busy member's clock starts again from now. True when any changed.
 */
export function watchFrom(s: FleetState, now: number): boolean {
  let moved = false
  for (const m of Object.values(s.members))
    if (busy(m) && (m.lastOutputAt ?? m.createdAt) < now) {
      m.lastOutputAt = now
      moved = true
    }
  return moved
}

function outputTick() {
  if (!live) return
  for (const s of live.teams()) {
    let moved = false
    for (const m of Object.values(s.members)) if (busy(m) && stampOutput(m, live.ctx.ptys.lastOutput(m.id))) moved = true
    if (moved) live.changed(s)
  }
}

// ---------------------------------------------------------------- the work so far

const sampling = new Set<string>()

/** Lines in a new file, for the diff's count; 0 for one too big to read on a tick, or binary. */
function linesIn(file: string): number {
  try {
    // a worker's untracked file can be anything it made: a FIFO or a link to a device would hang or
    // exhaust the main process on a plain read
    const text = readRegularText(file, 1_000_000)
    if (text.includes('\0')) return 0
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Pathspecs that leave the dependency folders out of a worktree's `git add` and untracked list, but
 * only those the repo tracks nothing under: a committed vendor/ is work like any other file.
 */
export async function outsideWork(cwd: string): Promise<string[]> {
  const tracked = await git(cwd, ['ls-files', '-z', '--', ...HEAVY_DIRS], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
  // unknown is treated as tracked, committing a dependency folder being cheaper than losing an edit;
  // but never the link to the user's own node_modules, which is not a folder the repo could hold
  if (tracked.code !== 0) return LINKED_DIRS.filter((d) => isLink(path.join(cwd, d))).map((d) => `:(exclude)${d}`)
  const has = new Set(tracked.stdout.split('\0').filter(Boolean).map((f) => f.split('/')[0]))
  return HEAVY_DIRS.filter((d) => !has.has(d)).map((d) => `:(exclude)${d}`)
}

async function sampleDiff(s: FleetState, m: FleetMember) {
  if (sampling.has(m.id)) return
  sampling.add(m.id)
  try {
    const opts = { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
    const skip = await outsideWork(m.cwd)
    const [num, others] = await Promise.all([
      git(m.cwd, ['diff', '--numstat', 'HEAD'], opts),
      git(m.cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...skip], opts)
    ])
    if (num.code !== 0 || others.code !== 0) return
    const untracked = others.stdout
      .split('\0')
      .filter(Boolean)
      .slice(0, 200)
      .map((p) => ({ path: p, lines: linesIn(path.join(m.cwd, p)) }))
    const d = liveDiff(num.stdout.trim(), untracked, Date.now())
    if (sameDiff(m.diff, d)) return
    m.diff = d
    live?.changed(s)
  } finally {
    sampling.delete(m.id)
  }
}

function diffTick() {
  if (!live) return
  for (const s of live.teams())
    for (const m of Object.values(s.members))
      // a worker's own worktree only: a reviewer sits in its lead's, which holds the merged work, not its own
      if (m.role === 'worker' && busy(m) && m.branch && m.cwd.startsWith(live.trees + path.sep) && fs.existsSync(m.cwd)) void sampleDiff(s, m)
}

// ---------------------------------------------------------------- the charter's check

/** project id → the run in flight, so dismissing the team or switching the check off ends it */
const inflight = new Map<string, AbortController>()

/** The Lead the charter belongs to: one team at a time, so the newest Lead that has not been closed. */
const leadOf = (s: FleetState) =>
  Object.values(s.members)
    .filter((m) => m.role === 'lead' && m.status !== 'closed')
    .sort((a, b) => b.createdAt - a.createdAt)[0]

/**
 * Run the charter's done-when in the Lead's integration worktree, if it may run now (mayRun). The
 * command is the charter's doneWhen as confirmed — nothing else is ever run here — and the Lead must
 * be working when it is asked: that is decided before anything is awaited, so a trigger cannot slip
 * through as the Lead finishes.
 */
export async function runCheck(s: FleetState, reason: 'start' | 'merge' | 'tick'): Promise<void> {
  if (!live) return
  const command = s.charter?.doneWhen ?? ''
  const lead = leadOf(s)
  const leadWorking = !!lead && lead.status === 'working' && live.ctx.ptys.status(lead.id) !== null
  const inWorktree = !!lead?.branch && lead.cwd.startsWith(live.trees + path.sep)
  if (!lead || !command) return
  // a new charter (a new team) starts a new history; whether it is switched off is the user's and stays
  if (s.check && s.check.command !== command) s.check = { command, runs: [], ...(s.check.off ? { off: true } : {}) }
  const check = s.check ?? { command, runs: [] }
  const head = inWorktree ? (await git(lead.cwd, ['rev-parse', 'HEAD'], { timeout: 20_000 })).stdout.trim() || undefined : undefined
  // what is in flight is this map's to say: `check.running` is for the board, and survives a stop until the process closes
  const ok = mayRun({ command, off: check.off, running: inflight.has(s.projectId) ? 1 : undefined, leadWorking, inWorktree, head, lastHead: check.runs[check.runs.length - 1]?.head, reason })
  if (ok !== true) return
  const ac = new AbortController()
  inflight.set(s.projectId, ac)
  s.check = { ...check, running: Date.now() }
  live.changed(s)
  try {
    const run = await observeCheck(lead.cwd, command, head, ac.signal)
    // a new team's charter meanwhile: this answer is about a job nobody is doing any more
    if (s.check?.command !== command) return
    // stopped (dismissed, switched off): not a result, and a run started since then is not this one's to clear
    if (ac.signal.aborted) {
      if (!inflight.has(s.projectId)) delete s.check.running
    } else s.check = withRun(s.check, run)
  } finally {
    if (inflight.get(s.projectId) === ac) inflight.delete(s.projectId)
    live.changed(s)
  }
}

/** Capture process evidence independently of anything an agent reports. */
export async function observeCheck(cwd: string, command: string, head?: string, signal?: AbortSignal): Promise<CheckRun> {
  const before = await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])
  const r = await runGoalCheck(cwd, command, CHECK_TIMEOUT_MS, signal)
  const after = await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])
  const endHead = await git(cwd, ['rev-parse', 'HEAD'])
  const stable = !!head && before.code === 0 && after.code === 0 && !before.stdout.trim() && !after.stdout.trim() && endHead.code === 0 && endHead.stdout.trim() === head
  const failing = r.code === 0 ? (failingCount(r.tail) ?? 0) : failingCount(r.tail)
  return { at: Date.now(), code: r.code, tail: r.tail.slice(-4000), stable, ...(failing !== undefined ? { failing } : {}), ...(head ? { head } : {}), ...(r.error ? { error: r.error } : {}), ...(r.timedOut ? { timedOut: true } : {}) }
}

/** End the run in flight for a project (its team was dismissed, or the user switched the check off). */
export function stopCheck(projectId: string) {
  inflight.get(projectId)?.abort()
  // forgotten now, not when its process has finished closing: a new team's baseline asked for a
  // moment later would otherwise be refused as overlapping a run that is already over
  inflight.delete(projectId)
}

function checkTick() {
  if (!live) return
  for (const s of live.teams()) if (s.charter?.doneWhen) void runCheck(s, 'tick')
}

// ---------------------------------------------------------------- lifecycle

/** Start sampling. Called by fleet.register once the teams are loaded. */
export function startLive(l: Live) {
  live = l
  const now = Date.now()
  for (const s of l.teams()) {
    let moved = watchFrom(s, now)
    // a run in flight when the app last quit is not in flight now: left set, nothing would run again
    if (s.check?.running) {
      delete s.check.running
      moved = true
    }
    if (moved) l.changed(s)
  }
  for (const [fn, ms] of [
    [outputTick, OUTPUT_TICK_MS],
    [diffTick, DIFF_TICK_MS],
    [checkTick, CHECK_TICK_MS]
  ] as const) {
    const t = setInterval(fn, ms)
    t.unref?.()
    ticks.push(t)
  }
}

export function stopLive() {
  for (const t of ticks) clearInterval(t)
  ticks.length = 0
  for (const ac of inflight.values()) ac.abort()
  inflight.clear()
}
