import { useApp, allConsoles } from '../state/store'
import { runCli, uid } from '../lib/api'
import { agentLabel, consoleTail, isLive, onConsoleData, sendToConsole } from './consoles'
import type { ConsoleStatus } from '@shared/types'

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
  ended?: { reason: 'goal' | 'runs' | 'time'; at: number; note?: string }
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
export function removeLoop(id: string) {
  saveLoops(getLoops().filter((l) => l.id !== id))
}
/** Play / pause. Re-enabling restarts the clock and clears a finished state. */
export function setLoopEnabled(id: string, enabled: boolean) {
  const l = getLoops().find((x) => x.id === id)
  if (!l) return
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

const strip = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const buffers = new Map<string, string>()
const dataSubs = new Map<string, () => void>()
/** recent sends per console, to ignore our own echo */
const lastSent = new Map<string, number>()
/** last fire per `${loopId}:${consoleId}` */
const lastFire = new Map<string, number>()
const busy = new Set<string>()

function compile(t: Extract<LoopTrigger, { kind: 'output' }>): RegExp | null {
  if (!t.pattern) return null
  try {
    return t.regex ? new RegExp(t.pattern, 'i') : new RegExp(t.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  } catch {
    return null
  }
}

/** Consoles this loop may fire into now: live, not paused, active workspace unless background. */
function eligible(l: Loop, ids = loopTargets(l)): string[] {
  const app = useApp.getState()
  const activeId = app.project?.activeWorkspaceId
  const wsOf = new Map(allConsoles().map((c) => [c.id, c.workspaceId]))
  return ids.filter((id) => isLive(id) && app.statuses[id] !== 'paused' && (l.background || wsOf.get(id) === activeId))
}

function retire(l: Loop, reason: 'goal' | 'runs' | 'time', note?: string) {
  updateLoop(l.id, { enabled: false, ended: { reason, at: Date.now(), note } })
  const msg = reason === 'goal' ? `Loop “${l.name}”: goal met ✓` : reason === 'runs' ? `Loop “${l.name}” finished its runs` : `Loop “${l.name}” reached its time limit`
  useApp.getState().toast(msg, 'ok')
}

/** Ask a CLI whether the goal is met. Resolves { met, note }. */
export async function checkGoal(l: Loop, consoleIds: string[]): Promise<{ met: boolean; note: string }> {
  const app = useApp.getState()
  const cwd = app.project?.path
  if (!cwd) return { met: false, note: 'no project' }
  const s = l.stop
  if (s.goalKind === 'command') {
    const prompt = `Run \`${s.command}\` in this repo. Reply with only PASS if it exits 0, otherwise FAIL.`
    const { text } = await runCli({ prompt, cwd, allowTools: true }).promise
    const met = /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text)
    return { met, note: met ? `\`${s.command}\` passed` : `\`${s.command}\` failed` }
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
  const { text } = await runCli({ prompt, cwd, agentId: s.judgeAgent || undefined }).promise
  const first = text.trim().split('\n')[0] ?? ''
  const met = /^\W*MET\b/i.test(first) && !/NOT[_ ]?MET/i.test(first)
  return { met, note: text.trim().split('\n').slice(1).join(' ').trim().slice(0, 200) || first }
}

/** Fire a loop into the given consoles, checking the goal first when one is set. */
async function fire(loopId: string, ids: string[]) {
  if (busy.has(loopId)) return
  const l = getLoops().find((x) => x.id === loopId)
  if (!l || !l.enabled || !l.instruction.trim()) return
  const targets = eligible(l, ids)
  if (!targets.length) {
    // nothing to type into: still advance the schedule so it does not fire in a burst later
    if (l.trigger.kind === 'schedule') updateLoop(l.id, { lastRunAt: Date.now() })
    return
  }
  busy.add(loopId)
  try {
    if (l.stop.goal && l.runs > 0) {
      const verdict = await checkGoal(l, targets).catch((e) => ({ met: false, note: String(e) }))
      updateLoop(l.id, { lastCheck: { at: Date.now(), ...verdict } })
      if (verdict.met) return retire(l, 'goal', verdict.note)
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
