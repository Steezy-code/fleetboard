import { useApp, allConsoles } from '../state/store'
import { runCli, uid, request } from '../lib/api'
import { journal } from '../lib/journal'
import { maySpendOn, spendable } from './guards'
import { agentLabel, consoleTail, isLive, onConsoleData, sendToConsole } from './consoles'
import type { ConsoleStatus } from '@shared/types'
import { stripAnsi } from '@shared/ansi'
import { readOnlyAgent } from '@shared/agents'

// Loops: recurring instructions typed into consoles on a schedule, when an agent goes idle, or when
// its output matches. Stored per project in extras.loops; run by startLoops() (registered engine).

export type LoopTrigger =
  | { kind: 'schedule'; everyMin: number }
  | { kind: 'idle' }
  | { kind: 'output'; pattern: string; regex: boolean }

export interface LoopStop {
  afterRuns: boolean
  runs: number
  afterTime: boolean
  minutes: number
  goal: boolean
  goalKind: 'command' | 'judge'
  command: string
  judgeAgent: string
  goalText: string
}

export interface Loop {
  id: string
  name: string
  instruction: string
  trigger: LoopTrigger
  target: { kind: 'all' } | { kind: 'pick'; ids: string[] }
  stop: LoopStop
  /** keep firing for consoles in workspaces other than the active one */
  background: boolean
  enabled: boolean
  createdAt: number
  /** when the loop was (re)started; schedule and time limit count from here */
  startedAt: number
  lastRunAt?: number
  runs: number
  /** why the loop retired itself */
  ended?: { reason: 'goal' | 'runs' | 'time' | 'stalled' | 'unchecked'; at: number; note?: string }
  /** last goal check verdict */
  lastCheck?: { at: number; met: boolean; note: string }
}

export const DEFAULT_STOP: LoopStop = {
  afterRuns: false,
  runs: 10,
  afterTime: false,
  minutes: 60,
  goal: false,
  goalKind: 'judge',
  command: 'npm test',
  judgeAgent: 'claude',
  goalText: ''
}

export function newLoop(partial: Partial<Loop> = {}): Loop {
  const now = Date.now()
  return {
    id: uid('loop'),
    name: 'New loop',
    instruction: '',
    trigger: { kind: 'schedule', everyMin: 15 },
    target: { kind: 'all' },
    stop: { ...DEFAULT_STOP },
    background: true,
    enabled: true,
    createdAt: now,
    startedAt: now,
    runs: 0,
    ...partial
  }
}

// ---------------- storage ----------------

export const getLoops = (): Loop[] => (useApp.getState().project?.extras.loops as Loop[] | undefined) ?? []
const saveLoops = (loops: Loop[]) => useApp.getState().setProjectExtra('loops', loops)

export function upsertLoop(loop: Loop) {
  const loops = getLoops()
  const i = loops.findIndex((l) => l.id === loop.id)
  saveLoops(i < 0 ? [...loops, loop] : loops.map((l) => (l.id === loop.id ? loop : l)))
}
export function updateLoop(id: string, patch: Partial<Loop>) {
  saveLoops(getLoops().map((l) => (l.id === id ? { ...l, ...patch } : l)))
}

/**
 * Save what the editor changes on a loop that already exists: its settings, never its run state.
 * The draft was copied when the editor opened, and the engine has gone on counting runs, checking
 * the goal and perhaps retiring the loop since; writing the copy back would undo all of it. False
 * when the loop was deleted meanwhile, rather than bringing it back.
 */
export function saveEditedLoop(draft: Loop): boolean {
  if (!getLoops().some((l) => l.id === draft.id)) return false
  const { name, instruction, trigger, target, stop, background } = draft
  updateLoop(draft.id, { name, instruction, trigger, target, stop, background })
  return true
}
export function removeLoop(id: string) {
  saveLoops(getLoops().filter((l) => l.id !== id))
}
/** Play / pause. Re-enabling restarts the clock and clears a finished state. */
export function setLoopEnabled(id: string, enabled: boolean) {
  const l = getLoops().find((x) => x.id === id)
  if (!l) return
  progress.delete(id)
  updateLoop(id, enabled ? { enabled, startedAt: Date.now(), lastRunAt: undefined, runs: l.ended ? 0 : l.runs, ended: undefined } : { enabled })
}

// ---------------- description helpers (editor + list) ----------------

export const fmtEvery = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`)

export function nextRunAt(l: Loop): number | null {
  if (!l.enabled || l.trigger.kind !== 'schedule') return null
  return (l.lastRunAt ?? l.startedAt) + l.trigger.everyMin * 60_000
}

/** Target console ids right now (not filtered by liveness). */
export function loopTargets(l: Pick<Loop, 'target'>): string[] {
  const all = allConsoles().map((c) => c.id)
  if (l.target.kind === 'all') return all
  const set = new Set(all)
  return l.target.ids.filter((id) => set.has(id))
}

export function describeLoop(l: Pick<Loop, 'trigger' | 'target' | 'stop'>): string {
  const t = l.trigger
  const when =
    t.kind === 'schedule'
      ? `Every ${fmtEvery(t.everyMin)}`
      : t.kind === 'idle'
        ? 'Whenever a targeted console goes idle'
        : `Whenever output contains ${t.regex ? `/${t.pattern || '…'}/` : `“${t.pattern || '…'}”`}`
  const n = l.target.kind === 'pick' ? l.target.ids.length : 0
  const target =
    t.kind !== 'schedule'
      ? 'that console'
      : l.target.kind === 'all'
        ? 'every console on the board'
        : n === 1
          ? '1 picked console'
          : `${n} picked consoles`
  const s = l.stop
  const limits: string[] = []
  if (s.afterRuns) limits.push(`${s.runs} run${s.runs === 1 ? '' : 's'}`)
  if (s.afterTime) limits.push(fmtEvery(s.minutes))
  let sentence = `${when}, the instruction is sent to ${target}`
  if (limits.length) sentence += `, for up to ${limits.join(' or ')}`
  if (s.goal) {
    sentence +=
      s.goalKind === 'command'
        ? `, until \`${s.command || '…'}\` passes`
        : `, until ${agentLabel(s.judgeAgent).replace(/ Code$| CLI$/, '')} judges the goal met`
  }
  // nothing ends it: say so, it costs tokens for as long as it runs
  if (!limits.length && !s.goal) sentence += ', with no end: it runs until you turn it off'
  return sentence + '.'
}

export function rateEstimate(l: Pick<Loop, 'trigger' | 'target'>): string {
  const n = l.target.kind === 'all' ? allConsoles().length : l.target.ids.length
  const c = `${n} console${n === 1 ? '' : 's'}`
  if (l.trigger.kind === 'schedule') return `≈ ${((60 / l.trigger.everyMin) * n).toFixed(1)} prompts/h across ${c}`
  if (l.trigger.kind === 'idle') return `one prompt each time one of ${c} finishes`
  return `at most 2 prompts/min per console across ${c}`
}

// ---------------- engine ----------------

const TICK_MS = 5000
const OUTPUT_DEBOUNCE_MS = 30_000
const IDLE_DEBOUNCE_MS = 8000
const BUF = 4096

// TUIs place words with cursor moves (Claude Code: ESC[9G before each word); those become spaces,
// so a pattern like "tests failed" matches what the user sees
// eslint-disable-next-line no-control-regex
const strip = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const buffers = new Map<string, string>()
const dataSubs = new Map<string, () => void>()
/** recent sends per console, to ignore our own echo */
const lastSent = new Map<string, number>()
/** last fire per `${loopId}:${consoleId}` */
const lastFire = new Map<string, number>()
/** goal checks in a row that could not run, per loop */
const goalFailures = new Map<string, number>()
const busy = new Set<string>()

/**
 * Consecutive runs that changed nothing before a loop gives up on itself.
 *
 * An idle-triggered loop fires every time a console goes working → idle, so an agent with nothing left
 * to do gets re-prompted for ever, at full price, and says the same thing every time. Four runs is
 * enough to tell that apart from a slow one.
 */
const STALL_RUNS = 4
const progress = new Map<string, { print: string; same: number }>()

/**
 * A fingerprint of what the targeted consoles are showing — of the part that means something.
 *
 * The obvious version of this never fires: an agent TUI redraws an elapsed counter ("esc to
 * interrupt · 12s") every second, so the screen is never byte-identical even when nothing is
 * happening. Digits go, whitespace collapses, and only the last lines count — so a spinner and a
 * clock look the same from one run to the next, while real work does not.
 */
async function screenPrint(ids: string[]): Promise<string | null> {
  const tails = await Promise.all(ids.map((id) => consoleTail(id, 4000).then((t) => t, () => null)))
  // a screen we could not read is not evidence of anything: no information, no verdict
  if (tails.some((t) => t === null)) return null
  return tails
    .map((t) =>
      (t ?? '')
        .split('\n')
        .map((l) => l.replace(/\d+/g, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(-40)
        .join('\n')
    )
    .join('\u001f')
}

/**
 * Has anything changed since the last time this loop prompted? Read just after prompting, so the hot
 * path does not wait on it: the instruction is the same every run, so the echo of it is too, and what
 * is left is whatever the agent had produced by the time it was asked again.
 */
async function checkProgress(l: Loop, targets: string[]) {
  const print = await screenPrint(targets)
  if (print === null) return
  const before = progress.get(l.id)
  const same = before && before.print === print ? before.same + 1 : 0
  progress.set(l.id, { print, same })
  if (same < STALL_RUNS) return
  const cur = getLoops().find((x) => x.id === l.id)
  if (cur?.enabled) retire(cur, 'stalled', `nothing on the targeted consoles changed across ${same + 1} runs, so it was spending for nothing`)
}

function compile(t: Extract<LoopTrigger, { kind: 'output' }>): RegExp | null {
  if (!t.pattern) return null
  try {
    return t.regex ? new RegExp(t.pattern, 'i') : new RegExp(t.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  } catch {
    return null
  }
}

/**
 * Statuses a loop never types into. A console that needs you shows a question: the instruction's
 * keys would land in it and its Enter would pick the highlighted answer (often "Yes").
 */
const NOT_NOW = new Set<ConsoleStatus>(['needs-you', 'starting', 'paused', 'exited', 'done'])

/** Consoles this loop may fire into now: live, not asking or stopped, active workspace unless background. */
function eligible(l: Loop, ids = loopTargets(l)): string[] {
  const app = useApp.getState()
  const activeId = app.project?.activeWorkspaceId
  const wsOf = new Map(allConsoles().map((c) => [c.id, c.workspaceId]))
  return ids.filter((id) => {
    const status = app.statuses[id]
    return isLive(id) && !(status && NOT_NOW.has(status)) && (l.background || wsOf.get(id) === activeId)
  })
}

const RETIRED: Record<NonNullable<Loop['ended']>['reason'], string> = {
  goal: 'goal met ✓',
  runs: 'finished its runs',
  time: 'reached its time limit',
  stalled: 'stopped: nothing is changing',
  unchecked: 'stopped: its goal could not be checked'
}

function retire(l: Loop, reason: NonNullable<Loop['ended']>['reason'], note?: string) {
  updateLoop(l.id, { enabled: false, ended: { reason, at: Date.now(), note } })
  progress.delete(l.id)
  const msg = `Loop “${l.name}” ${RETIRED[reason]}`
  useApp.getState().toast(msg, reason === 'stalled' || reason === 'unchecked' ? 'warn' : 'ok')
  // the toast is gone in four seconds, and this is how a loop ends
  journal('loop.end', note ? `${msg} — ${note}` : msg, { loop: l.id, name: l.name, reason, runs: l.runs })
}

/** Ask a CLI whether the goal is met. Resolves { met, note }. */
export async function checkGoal(l: Loop, consoleIds: string[]): Promise<{ met: boolean; note: string; failed?: boolean }> {
  const app = useApp.getState()
  const cwd = app.project?.path
  if (!cwd) return { met: false, note: 'no project' }
  const s = l.stop
  if (s.goalKind === 'command') {
    // run by the app itself: its exit code decides (a model asked to run it could also edit the code)
    const r = await request('goal:check', cwd, s.command)
    const last = r.tail.trim().split('\n').filter((l) => l.trim()).at(-1)?.trim().slice(0, 140)
    if (r.code === 0) return { met: true, note: `\`${s.command}\` passed` }
    if (r.error) return { met: false, failed: true, note: `\`${s.command}\` could not run: ${r.error}` }
    if (r.timedOut) return { met: false, failed: true, note: `\`${s.command}\` took too long and was stopped` }
    return { met: false, note: `\`${s.command}\` failed (exit ${r.code})${last ? `: ${last}` : ''}` }
  }
  const names = new Map(allConsoles().map((c) => [c.id, c.data.name as string]))
  const tails = await Promise.all(consoleIds.slice(0, 6).map(async (id) => `### ${names.get(id) ?? id}\n${(await consoleTail(id, 3000)).trim()}`))
  const prompt = [
    'You are checking whether a recurring instruction loop can stop.',
    `Goal: ${s.goalText || 'the task given to the agents is complete'}`,
    `Instruction the agents keep receiving: ${l.instruction}`,
    'Recent terminal output of the agents follows. Judge only from it; do not use tools.',
    '',
    tails.join('\n\n'),
    '',
    'Reply on the first line with exactly MET or NOT_MET, then one short sentence why.'
  ].join('\n')
  const { code, text } = await runCli({ prompt, cwd, agentId: readOnlyAgent(s.judgeAgent) }).promise
  // a judge that errored (signed out, an API outage) gave no verdict: a check that could not be made
  if (code !== 0) return { met: false, failed: true, note: `the judge could not answer: ${text.trim().split('\n').at(-1)?.slice(0, 140) || `exit ${code}`}` }
  const first = text.trim().split('\n')[0] ?? ''
  const met = /^\W*MET\b/i.test(first) && !/NOT[_ ]?MET/i.test(first)
  return { met, note: text.trim().split('\n').slice(1).join(' ').trim().slice(0, 200) || first }
}

/** Fire a loop into the given consoles, checking the goal first when one is set. */
async function fire(loopId: string, ids: string[]) {
  if (busy.has(loopId)) return
  const l = getLoops().find((x) => x.id === loopId)
  if (!l || !l.enabled || !l.instruction.trim()) return
  // nothing unattended spends past the ceiling; the user typing into the same console still does
  const targets = spendable(eligible(l, ids), `loop “${l.name}”`)
  if (!targets.length) {
    // nothing to type into: still advance the schedule so it does not fire in a burst later
    if (l.trigger.kind === 'schedule') updateLoop(l.id, { lastRunAt: Date.now() })
    return
  }
  busy.add(loopId)
  try {
    if (l.stop.goal && l.runs > 0) {
      // A goal is how this loop ends, so it does not go on unchecked: with its judge at the spend
      // ceiling it waits (and its schedule moves on), and a check that cannot run three times in a
      // row ends it, rather than firing forever on a "not met" that was never a verdict.
      if (l.stop.goalKind === 'judge' && !maySpendOn(l.stop.judgeAgent, 'judging whether a loop can stop')) {
        if (l.trigger.kind === 'schedule') updateLoop(l.id, { lastRunAt: Date.now() })
        return
      }
      const verdict = await checkGoal(l, targets).catch((e) => ({ met: false, failed: true, note: String(e) }))
      updateLoop(l.id, { lastCheck: { at: Date.now(), met: verdict.met, note: verdict.note } })
      journal('loop.goal', `Loop “${l.name}”: goal ${verdict.met ? 'met' : verdict.failed ? 'not checked' : 'not met'} — ${verdict.note}`, { loop: l.id, met: verdict.met })
      if (verdict.met) return retire(l, 'goal', verdict.note)
      const failures = verdict.failed ? (goalFailures.get(l.id) ?? 0) + 1 : 0
      goalFailures.set(l.id, failures)
      if (failures >= 3) return retire(l, 'unchecked', verdict.note)
    }
    const cur = getLoops().find((x) => x.id === loopId)
    if (!cur?.enabled) return
    const now = Date.now()
    for (const id of targets) {
      sendToConsole(id, cur.instruction)
      lastSent.set(id, now)
      lastFire.set(`${loopId}:${id}`, now)
    }
    const runs = cur.runs + 1
    updateLoop(cur.id, { runs, lastRunAt: now })
    // nothing changing is a reason to stop, not a reason to prompt again
    void checkProgress(cur, targets)
    const names = new Map(allConsoles().map((c) => [c.id, String(c.data.name ?? c.id)]))
    journal('loop.fire', `Loop “${cur.name}” (run ${runs}) sent its instruction to ${targets.map((id) => names.get(id) ?? id).join(', ')}`, {
      loop: cur.id,
      run: runs,
      instruction: cur.instruction.slice(0, 300),
      consoles: targets
    })
    if (cur.stop.afterRuns && runs >= cur.stop.runs) retire({ ...cur, runs }, 'runs')
  } finally {
    busy.delete(loopId)
  }
}

/** Run a loop once now (from the list's "Run now"). */
export const runLoopNow = (id: string) => {
  const l = getLoops().find((x) => x.id === id)
  if (l) fire(id, loopTargets(l))
}

function onData(id: string, chunk: string) {
  const prev = buffers.get(id) ?? ''
  const clean = strip(chunk)
  const buf = (prev + clean).slice(-BUF)
  buffers.set(id, buf)
  const now = Date.now()
  if (now - (lastSent.get(id) ?? 0) < 4000) return
  // test the new data plus a little overlap so matches across chunk boundaries count
  const window = buf.slice(-(clean.length + 200))
  for (const l of getLoops()) {
    if (!l.enabled || l.trigger.kind !== 'output') continue
    if (!loopTargets(l).includes(id)) continue
    const re = compile(l.trigger)
    if (!re || !re.test(window)) continue
    const key = `${l.id}:${id}`
    if (now - (lastFire.get(key) ?? 0) < OUTPUT_DEBOUNCE_MS) continue
    lastFire.set(key, now)
    fire(l.id, [id])
  }
}

/** Keep output subscriptions for consoles targeted by any enabled output loop. */
function syncDataSubs() {
  const want = new Set<string>()
  for (const l of getLoops()) if (l.enabled && l.trigger.kind === 'output') loopTargets(l).forEach((id) => want.add(id))
  for (const [id, off] of dataSubs) if (!want.has(id)) (off(), dataSubs.delete(id), buffers.delete(id))
  for (const id of want) if (!dataSubs.has(id)) dataSubs.set(id, onConsoleData(id, (d) => onData(id, d)))
}

function tick() {
  const app = useApp.getState()
  if (!app.project) return
  const now = Date.now()
  for (const l of getLoops()) {
    if (!l.enabled) continue
    if (l.stop.afterTime && now - l.startedAt >= l.stop.minutes * 60_000) {
      retire(l, 'time')
      continue
    }
    const due = nextRunAt(l)
    if (due !== null && now >= due) fire(l.id, loopTargets(l))
  }
  syncDataSubs()
}

let started = false
export function startLoops() {
  if (started) return
  started = true
  window.setInterval(tick, TICK_MS)

  let prevStatuses: Record<string, ConsoleStatus> = useApp.getState().statuses
  let prevProject = useApp.getState().project?.id
  useApp.subscribe((s) => {
    if (s.project?.id !== prevProject) {
      prevProject = s.project?.id
      for (const off of dataSubs.values()) off()
      dataSubs.clear()
      buffers.clear()
      lastFire.clear()
      if (s.project) window.setTimeout(syncDataSubs, 500)
    }
    if (s.statuses === prevStatuses) return
    const prev = prevStatuses
    prevStatuses = s.statuses
    if (!s.project) return
    const finished = Object.keys(s.statuses).filter((id) => prev[id] === 'working' && s.statuses[id] === 'idle')
    if (!finished.length) return
    const now = Date.now()
    for (const l of getLoops()) {
      if (!l.enabled || l.trigger.kind !== 'idle') continue
      const targets = new Set(loopTargets(l))
      const ids = finished.filter((id) => targets.has(id) && now - (lastFire.get(`${l.id}:${id}`) ?? 0) > IDLE_DEBOUNCE_MS)
      if (ids.length) fire(l.id, ids)
    }
  })
}
