// Live work against the charter: the clock on each task and its estimate, the work a worker has on
// disk before it reports, the choices it says it made, and the charter's check as it runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FleetTask } from '../../src/shared/fleet'
import {
  checkTrend,
  commandLike,
  decisionsOf,
  diffLabel,
  elapsedLabel,
  estimateOf,
  failingCount,
  farOver,
  liveDiff,
  mayRun,
  overEstimate,
  stampTask,
  withRun,
  MAX_RUNS,
  type CheckRun,
  type DoneWhenCheck
} from '../../src/shared/live'
import { coerceCharter } from '../../src/shared/charter'

const MIN = 60_000

// ---------------------------------------------------------------- time against an estimate

test('elapsed reads against the estimate, running or finished', () => {
  assert.equal(elapsedLabel({ startedAt: 0, estimate: 5 }, 12 * MIN), '12 min, est 5 min')
  assert.equal(elapsedLabel({ startedAt: 0, endedAt: 12 * MIN, estimate: 5 }, 99 * MIN), 'took 12 min, est 5 min')
  assert.equal(elapsedLabel({ startedAt: 0 }, 4 * MIN), '4 min')
  assert.equal(elapsedLabel({ startedAt: 0 }, 20_000), '<1 min')
  assert.equal(elapsedLabel({ startedAt: 0 }, 65 * MIN), '1 h 5 min')
  assert.equal(elapsedLabel({ estimate: 10 }, 0), 'est 10 min', 'not started: only what it is expected to take')
  assert.equal(elapsedLabel({}, 0), '')
})

test('over the estimate is a colour; twice it and five minutes past is worth saying', () => {
  assert.equal(overEstimate({ startedAt: 0, estimate: 5 }, 5 * MIN), false)
  assert.equal(overEstimate({ startedAt: 0, estimate: 5 }, 6 * MIN), true)
  assert.equal(overEstimate({ startedAt: 0 }, 600 * MIN), false, 'nothing estimated, nothing to be over')
  assert.equal(farOver({ startedAt: 0, estimate: 5 }, 9 * MIN), false)
  assert.equal(farOver({ startedAt: 0, estimate: 5 }, 10 * MIN), true)
  assert.equal(farOver({ startedAt: 0, estimate: 1 }, 3 * MIN), false, 'twice a one-minute estimate is not yet five minutes past it')
  assert.equal(farOver({ startedAt: 0, endedAt: MIN, estimate: 1 }, 99 * MIN), false, 'a finished task is not drifting')
})

test('a task’s clock starts once, stops when handed in, runs again if sent back', () => {
  const t: FleetTask = { id: 't', title: 'x', status: 'todo' }
  stampTask(t, 'doing', 100)
  stampTask(t, 'doing', 200)
  assert.equal(t.startedAt, 100)
  stampTask(t, 'review', 300)
  assert.equal(t.endedAt, 300)
  assert.equal(t.status, 'review')
  stampTask(t, 'doing', 400)
  assert.equal(t.endedAt, undefined)
  assert.equal(t.startedAt, 100, 'the same task, so the same start')
  stampTask(t, 'blocked', 500)
  assert.equal(t.endedAt, 500)
  const never: FleetTask = { id: 'n', title: 'y', status: 'todo' }
  stampTask(never, 'done', 100)
  assert.equal(never.endedAt, undefined, 'never started, so no span to close')
})

test('an estimate is whole minutes from one to ten hours, or none', () => {
  assert.equal(estimateOf(15), 15)
  assert.equal(estimateOf('20'), 20)
  assert.equal(estimateOf(4.6), 5)
  for (const bad of [0, -3, 601, 'soon', '15 minutes', null, undefined, {}, NaN, Infinity]) assert.equal(estimateOf(bad), undefined, String(bad))
})

test('the charter keeps a sane estimate and drops a silly one', () => {
  assert.equal(coerceCharter({ understood: 'u', estimate: 30 }, 'r').estimate, 30)
  assert.equal(coerceCharter({ understood: 'u', estimate: 'a while' }, 'r').estimate, undefined)
  assert.equal('estimate' in coerceCharter({ understood: 'u', estimate: 0 }, 'r'), false)
})

// ---------------------------------------------------------------- the work so far

test('the live diff counts each file once, tracked or new, and binaries as no lines', () => {
  const d = liveDiff('10\t2\tsrc/a.ts\n-\t-\tlogo.png\n3\t0\tsrc/b.ts', [{ path: 'src/new.ts', lines: 40 }, { path: 'src/a.ts', lines: 99 }], 5)
  assert.deepEqual(d, { files: 4, add: 53, del: 2, at: 5 })
  assert.equal(diffLabel(d), '4 files +53 −2')
  assert.equal(diffLabel(liveDiff('', [], 0)), '', 'nothing changed yet says nothing')
  assert.equal(diffLabel(liveDiff('1\t1\ta', [], 0)), '1 file +1 −1')
})

// ---------------------------------------------------------------- the decision log

test('decisions are the lines under "Decisions:", whatever their bullet', () => {
  const report = ['Added the split command.', 'Tests pass.', '', 'Decisions:', '- kept pdf-lib over pdfjs: already a dependency', '* page ranges are 1-based, like the UI', '1. no new flag: --pages covers it', '', 'Anything else'].join('\n')
  assert.deepEqual(decisionsOf(report), ['kept pdf-lib over pdfjs: already a dependency', 'page ranges are 1-based, like the UI', 'no new flag: --pages covers it'])
})

test('a decision can sit on the heading line, and the next heading ends the list', () => {
  assert.deepEqual(decisionsOf('Done.\nDecisions: used a Set over an array\nFiles:\n- a.ts'), ['used a Set over an array'])
  assert.deepEqual(decisionsOf('## Decisions\n- one\nVerified:\n- npm test'), ['one'])
})

test('no decisions section, no decisions', () => {
  assert.deepEqual(decisionsOf('Wrote a.txt'), [])
  assert.deepEqual(decisionsOf(undefined), [])
  assert.deepEqual(decisionsOf('Decisions:\n\n'), [])
})

// ---------------------------------------------------------------- the charter's check

// Review Focus 3
test('only a done-when shaped like a command is run', () => {
  for (const c of ['npm test', 'npm run typecheck && npm test', 'test -f a.txt', 'pytest -q tests/', './scripts/check.sh', 'cargo test', 'go test ./...', 'make check', 'node scripts/test-unit.mjs', 'grep -q split src/cli.ts'])
    assert.equal(commandLike(c), true, c)
  for (const c of ['', '   ', 'The page renders correctly', 'tests pass', 'npm test passes', 'the build succeeds', 'All tests are green.', 'npm test\nrm -rf ~', 'it works', '`npm test`'])
    assert.equal(commandLike(c), false, JSON.stringify(c))
})

test('how many failed, read off the summary', () => {
  assert.equal(failingCount('ℹ tests 48\nℹ pass 45\nℹ fail 3\nℹ cancelled 0'), 3)
  assert.equal(failingCount('Tests:       2 failed, 40 passed, 42 total'), 2)
  assert.equal(failingCount(' Test Files  1 failed | 9 passed (10)\n      Tests  4 failed | 120 passed (124)'), 4, 'the last count is the summary')
  assert.equal(failingCount('==== 7 failed, 93 passed in 3.2s ===='), 7)
  assert.equal(failingCount('  12 passing (2s)\n  1 failing'), 1)
  assert.equal(failingCount('Found 11 errors in 4 files.'), 11)
  assert.equal(failingCount('# tests 3\n# pass 3\n# fail 0'), 0)
  assert.equal(failingCount('all good'), undefined)
})

const run = (code: number | null, failing?: number, head = 'h'): CheckRun => ({ at: 0, code, head, ...(failing !== undefined ? { failing } : {}) })
const check = (runs: CheckRun[], o: Partial<DoneWhenCheck> = {}): DoneWhenCheck => ({ command: 'npm test', runs, ...o })

test('the trend reads against where the team started', () => {
  assert.equal(checkTrend(check([run(1, 11), run(1, 3)]), 'npm test'), '3 failing, down from 11')
  assert.equal(checkTrend(check([run(1, 3), run(1, 7)]), 'npm test'), '7 failing, up from 3')
  assert.equal(checkTrend(check([run(1, 11), run(0, 0)]), 'npm test'), 'passing, from 11 failing')
  assert.equal(checkTrend(check([run(0)]), 'npm test'), 'passing')
  assert.equal(checkTrend(check([run(1)]), 'npm test'), 'failing')
  assert.equal(checkTrend(check([]), 'npm test'), 'not run yet')
  assert.equal(checkTrend(check([], { running: 1 }), 'npm test'), 'running…')
  assert.equal(checkTrend(check([run(1, 2)], { running: 1 }), 'npm test'), '2 failing · running…')
  assert.equal(checkTrend(check([run(0)], { off: true }), 'npm test'), 'off · last passing')
  assert.equal(checkTrend(undefined, 'the page renders'), 'not a command, not run')
  assert.equal(checkTrend(check([{ at: 0, code: null, timedOut: true }]), 'npm test'), 'timed out')
})

test('a run starts only when it may, for every trigger alike', () => {
  const base = { command: 'npm test', leadWorking: true, inWorktree: true, reason: 'merge' as const }
  assert.equal(mayRun(base), true)
  assert.equal(mayRun({ ...base, command: 'the tests pass' }), 'not a command')
  assert.equal(mayRun({ ...base, off: true }), 'switched off')
  assert.equal(mayRun({ ...base, running: 5 }), 'already running')
  assert.equal(mayRun({ ...base, leadWorking: false }), 'its lead is not working')
  assert.equal(mayRun({ ...base, inWorktree: false }), 'no integration worktree', 'a team in the user’s own files has nowhere apart to run it')
  assert.equal(mayRun({ ...base, reason: 'tick', head: 'a', lastHead: 'a' }), 'nothing new to check')
  assert.equal(mayRun({ ...base, reason: 'tick', head: 'b', lastHead: 'a' }), true)
  assert.equal(mayRun({ ...base, reason: 'merge', head: 'a', lastHead: 'a' }), true, 'a merge always checks again')
})

test('a finished run is kept, the oldest dropped past the limit, and the run in flight cleared', () => {
  let c = check([], { running: 9 })
  for (let i = 0; i < MAX_RUNS + 3; i++) c = withRun(c, run(1, i))
  assert.equal(c.runs.length, MAX_RUNS)
  assert.equal(c.runs[0]?.failing, 3)
  assert.equal(c.running, undefined)
})

// ---------------------------------------------------------------- stamping output

test('an output time is written when it has moved enough to matter, and only forward', async () => {
  const { stampOutput } = await import('../../src/main/live')
  const m = { id: 'w', role: 'worker', name: 'Ada', agentId: 'claude', projectId: 'p', cwd: '/x', status: 'working', createdAt: 0 } as import('../../src/shared/fleet').FleetMember
  assert.equal(stampOutput(m, null), false, 'a console that is not running says nothing')
  assert.equal(stampOutput(m, 1000), true)
  assert.equal(stampOutput(m, 20_000), false, 'a chatty console does not rewrite the fleet file every tick')
  assert.equal(stampOutput(m, 31_000), true)
  assert.equal(m.lastOutputAt, 31_000)
  assert.equal(stampOutput(m, 5_000), false)
})

// Review Focus 4
test('after a restart, silence is counted from when the app started watching, not from before', async () => {
  const { watchFrom } = await import('../../src/main/live')
  const { emptyFleet } = await import('../../src/shared/fleet')
  const { stalled } = await import('../../src/shared/mergeReview')
  const s = emptyFleet('p', '/repo')
  const base = { role: 'worker', agentId: 'claude', projectId: 'p', cwd: '/x', createdAt: 0 } as const
  s.members = {
    w: { ...base, id: 'w', name: 'Ada', status: 'working', lastOutputAt: MIN },
    m: { ...base, id: 'm', name: 'Bo', status: 'merged', lastOutputAt: MIN }
  }
  const restart = 100 * MIN
  assert.equal(watchFrom(s, restart), true)
  assert.equal(s.members.w!.lastOutputAt, restart)
  assert.equal(s.members.m!.lastOutputAt, MIN, 'only members still going')
  assert.deepEqual(stalled(s, restart + 2 * MIN), [], 'two minutes since the restart is not a stall')
  assert.deepEqual(stalled(s, restart + 6 * MIN).map((x) => x.minutes), [6])
  assert.equal(watchFrom(s, restart), false, 'nothing older left to move')
})
