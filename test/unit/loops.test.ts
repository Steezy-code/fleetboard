// The loop engine against the real store, with the preload bridge faked and time mocked.
import { ipc } from '../support/renderer-env'
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 })
const { useApp } = await import('@/state/store')
const loops = await import('@/engine/loops')
const { wireConsoleEvents } = await import('@/engine/consoles')
wireConsoleEvents()
loops.startLoops()

const CONSOLES = ['idle1', 'working1', 'asking', 'starting1', 'paused1', 'gone']

function seed() {
  const node = (id: string) => ({ id, type: 'console', x: 0, y: 0, w: 100, h: 100, z: 1, data: { name: id, agentId: 'claude' } })
  useApp.setState({
    project: {
      schema: 1,
      id: 'p',
      name: 'p',
      path: '/tmp/p',
      activeWorkspaceId: 'w',
      lastOpened: 0,
      extras: {},
      workspaces: [{ id: 'w', name: 'W', nodes: CONSOLES.map(node), groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
    } as any,
    live: Object.fromEntries(CONSOLES.filter((c) => c !== 'gone').map((c) => [c, true])),
    statuses: { idle1: 'idle', working1: 'working', asking: 'needs-you', starting1: 'starting', paused1: 'paused', gone: 'exited' }
  })
}

const pastes = () => ipc.sent.filter((s) => s.channel === 'pty:paste').map((s) => s.args as [string, string, boolean])
const loop = (id: string) => loops.getLoops().find((l) => l.id === id)!

beforeEach(() => {
  ipc.sent.length = 0
  ipc.handlers.clear()
  seed()
})

test('a loop types only into consoles that can take it: never into one asking a question', () => {
  const l = loops.newLoop({ instruction: 'keep going', target: { kind: 'all' } })
  loops.upsertLoop(l)
  loops.runLoopNow(l.id)
  assert.deepEqual(
    pastes().map((p) => p[0]).sort(),
    ['idle1', 'working1'],
    'not into a permission prompt, a starting CLI, a paused or a stopped console'
  )
  assert.deepEqual(pastes()[0].slice(1), ['keep going', true])
  assert.equal(loop(l.id).runs, 1)
})

test('a loop with a run limit retires itself', () => {
  const l = loops.newLoop({ instruction: 'go', target: { kind: 'pick', ids: ['idle1'] }, stop: { ...loops.DEFAULT_STOP, afterRuns: true, runs: 2 } })
  loops.upsertLoop(l)
  loops.runLoopNow(l.id)
  loops.runLoopNow(l.id)
  loops.runLoopNow(l.id)
  assert.equal(pastes().length, 2)
  assert.equal(loop(l.id).enabled, false)
  assert.equal(loop(l.id).ended?.reason, 'runs')
})

test('a scheduled loop fires once per period, and not in a burst after a quiet time', () => {
  const l = loops.newLoop({ instruction: 'status?', trigger: { kind: 'schedule', everyMin: 15 }, target: { kind: 'pick', ids: ['idle1'] }, startedAt: Date.now() })
  loops.upsertLoop(l)
  mock.timers.tick(14 * 60_000)
  assert.equal(pastes().length, 0)
  mock.timers.tick(60_000 + 5000)
  assert.equal(pastes().length, 1)
  mock.timers.tick(15 * 60_000 + 5000)
  assert.equal(pastes().length, 2)
  // the console is busy asking for two periods: nothing is sent, and nothing piles up for later
  useApp.getState().setStatus('idle1', 'needs-you')
  mock.timers.tick(30 * 60_000)
  assert.equal(pastes().length, 2)
  useApp.getState().setStatus('idle1', 'idle')
  mock.timers.tick(15 * 60_000 + 5000)
  assert.equal(pastes().length, 3)
  loops.setLoopEnabled(l.id, false)
})

test('a time limit retires a loop', () => {
  const l = loops.newLoop({ instruction: 'x', trigger: { kind: 'schedule', everyMin: 5 }, target: { kind: 'pick', ids: ['idle1'] }, startedAt: Date.now(), stop: { ...loops.DEFAULT_STOP, afterTime: true, minutes: 12 } })
  loops.upsertLoop(l)
  mock.timers.tick(13 * 60_000)
  assert.equal(loop(l.id).ended?.reason, 'time')
  const sent = pastes().length
  mock.timers.tick(30 * 60_000)
  assert.equal(pastes().length, sent, 'nothing after it retired')
})

test('an idle loop fires when an agent finishes, once', () => {
  const l = loops.newLoop({ instruction: 'next step', trigger: { kind: 'idle' }, target: { kind: 'pick', ids: ['working1'] } })
  loops.upsertLoop(l)
  useApp.getState().setStatus('working1', 'idle')
  assert.deepEqual(pastes().map((p) => p[0]), ['working1'])
  // a quick flicker back and forth within the debounce does not fire again
  mock.timers.tick(2000)
  useApp.getState().setStatus('working1', 'working')
  useApp.getState().setStatus('working1', 'idle')
  assert.equal(pastes().length, 1)
  loops.setLoopEnabled(l.id, false)
})

test("an output loop matches words a TUI placed with cursor moves (Claude Code's output)", () => {
  const l = loops.newLoop({ instruction: 'fix it', trigger: { kind: 'output', pattern: 'tests failed', regex: false }, target: { kind: 'pick', ids: ['working1'] } })
  loops.upsertLoop(l)
  mock.timers.tick(5000) // the engine subscribes on its next tick
  ipc.emit('pty:data', 'working1', '\x1b[2G\x1b[1m3\x1b[4Gtests\x1b[10Gfailed\x1b[22m')
  assert.deepEqual(pastes().map((p) => p[0]), ['working1'])
  // the old stripping glued it into "3testsfailed": prove the pattern needed the fix
  assert.equal(/tests failed/.test('\x1b[2G3\x1b[4Gtests\x1b[10Gfailed'.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')), false)
  loops.setLoopEnabled(l.id, false)
})

test('a command goal is run by the app, never by a model, and its exit code decides', async () => {
  const runs: string[][] = []
  let modelAsked = false
  ipc.handle('cli:run', () => {
    modelAsked = true
    return { code: 0, text: 'PASS' }
  })
  let code = 1
  ipc.handle('goal:check', (cwd: string, command: string) => {
    runs.push([cwd, command])
    return { code, tail: code ? 'Tests: 1 failed, 4 passed\n' : 'Tests: 5 passed\n' }
  })
  const l = loops.newLoop({ instruction: 'fix the tests', target: { kind: 'pick', ids: ['idle1'] }, stop: { ...loops.DEFAULT_STOP, goal: true, goalKind: 'command', command: 'npm test' } })
  loops.upsertLoop(l)
  const settle = async () => {
    await mock.timers.tick(0)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  loops.runLoopNow(l.id)
  loops.runLoopNow(l.id)
  await settle()
  assert.deepEqual(runs, [['/tmp/p', 'npm test']])
  assert.equal(loop(l.id).lastCheck?.note, '`npm test` failed (exit 1): Tests: 1 failed, 4 passed')
  assert.equal(pastes().length, 2, 'not met: it keeps going')
  code = 0
  loops.runLoopNow(l.id)
  await settle()
  assert.equal(loop(l.id).ended?.reason, 'goal')
  assert.equal(loop(l.id).ended?.note, '`npm test` passed')
  assert.equal(pastes().length, 2, 'met: no more sends')
  assert.equal(modelAsked, false, 'no model was asked')
})

test('a goal judged met stops the loop before it sends again', async () => {
  ipc.handle('cli:run', () => ({ code: 0, text: 'MET\nAll tests pass now.' }))
  ipc.handle('pty:tail', () => '42 passing')
  const l = loops.newLoop({ instruction: 'keep fixing', target: { kind: 'pick', ids: ['idle1'] }, stop: { ...loops.DEFAULT_STOP, goal: true, goalKind: 'judge', goalText: 'tests pass' } })
  loops.upsertLoop(l)
  loops.runLoopNow(l.id) // the first run never asks: nothing was done yet
  assert.equal(pastes().length, 1)
  loops.runLoopNow(l.id)
  await mock.timers.tick(0)
  await new Promise((r) => setImmediate(r))
  assert.equal(pastes().length, 1, 'no second send')
  assert.equal(loop(l.id).ended?.reason, 'goal')
  assert.equal(loop(l.id).ended?.note, 'All tests pass now.')
})

test('the summary says when nothing ends a loop', () => {
  const base = { trigger: { kind: 'schedule', everyMin: 10 }, target: { kind: 'all' } } as any
  const stop = { afterRuns: false, runs: 3, afterTime: false, minutes: 60, goal: false, goalKind: 'command', command: 'npm test', judgeAgent: 'claude', goalText: '' }
  assert.match(loops.describeLoop({ ...base, stop }), /with no end: it runs until you turn it off\.$/)
  assert.doesNotMatch(loops.describeLoop({ ...base, stop: { ...stop, afterRuns: true } }), /no end/)
  assert.doesNotMatch(loops.describeLoop({ ...base, stop: { ...stop, goal: true } }), /no end/)
})

test('a loop that changes nothing stops itself, and a clock ticking is not a change', async () => {
  // An idle loop fires every time a console goes working → idle, so an agent with nothing left to do
  // is re-prompted for ever at full price. The screen is the signal — but an agent TUI redraws its
  // elapsed counter every second, so "the screen differs" would mean "always".
  const settle = async () => {
    await mock.timers.tick(0)
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
  }
  let seconds = 10
  ipc.handle('pty:tail', () => `> keep going\n\n✻ Thinking… (${seconds++}s · esc to interrupt)\n`)
  ipc.handle('journal:append', () => {})

  const l = loops.newLoop({ instruction: 'keep going', target: { kind: 'pick', ids: ['idle1'] } })
  loops.upsertLoop(l)
  for (let i = 0; i < 6; i++) {
    loops.runLoopNow(l.id)
    await settle()
  }
  assert.equal(loop(l.id).ended?.reason, 'stalled', 'the counter was the only thing moving')
  assert.match(loop(l.id).ended?.note ?? '', /nothing on the targeted consoles changed/)
  assert.equal(pastes().length, 5, 'it stopped rather than carrying on')

  // and a loop whose console is actually saying new things is left alone
  let n = 0
  ipc.handle('pty:tail', () => `> keep going\n\nfixed the ${['parser', 'lexer', 'printer', 'reader', 'writer', 'walker'][n++ % 6]}\n`)
  const m = loops.newLoop({ instruction: 'keep going', target: { kind: 'pick', ids: ['idle1'] } })
  loops.upsertLoop(m)
  for (let i = 0; i < 6; i++) {
    loops.runLoopNow(m.id)
    await settle()
  }
  assert.equal(loop(m.id).ended, undefined, 'still running')

  // a screen that cannot be read is no information, so it is not evidence of a stall either
  ipc.handle('pty:tail', () => {
    throw new Error('not live')
  })
  const k = loops.newLoop({ instruction: 'keep going', target: { kind: 'pick', ids: ['idle1'] } })
  loops.upsertLoop(k)
  for (let i = 0; i < 6; i++) {
    loops.runLoopNow(k.id)
    await settle()
  }
  assert.equal(loop(k.id).ended, undefined, 'no verdict without evidence')
})

test('a loop whose goal cannot be checked stops after three tries, instead of firing forever', async () => {
  ipc.handle('goal:check', () => ({ code: null, tail: '', error: 'npm: command not found' }))
  const l = loops.newLoop({ instruction: 'keep fixing', target: { kind: 'pick', ids: ['idle1'] }, stop: { ...loops.DEFAULT_STOP, goal: true, goalKind: 'command', command: 'npm test' } })
  loops.upsertLoop(l)
  loops.runLoopNow(l.id) // the first run sends without asking
  for (let i = 0; i < 3; i++) {
    loops.runLoopNow(l.id)
    await mock.timers.tick(0)
    await new Promise((r) => setImmediate(r))
  }
  assert.equal(loop(l.id).ended?.reason, 'unchecked')
  assert.equal(loop(l.id).enabled, false)
  assert.equal(pastes().length, 3, 'the first run and two unchecked ones; the third check ended it')
})

test('saving an edited loop keeps what the engine did while the editor was open', () => {
  const l = loops.newLoop({ name: 'tests', instruction: 'run the tests' })
  loops.upsertLoop(l)
  const draft = { ...l, instruction: 'run the tests again' }
  // meanwhile the engine ran it and retired it
  loops.updateLoop(l.id, { runs: 3, lastRunAt: 5, enabled: false, ended: { reason: 'runs', at: 6 } })
  assert.equal(loops.saveEditedLoop(draft), true)
  const saved = loops.getLoops().find((x) => x.id === l.id)!
  assert.equal(saved.instruction, 'run the tests again')
  assert.deepEqual([saved.runs, saved.lastRunAt, saved.enabled, saved.ended?.reason], [3, 5, false, 'runs'])
})

test('a loop deleted while its editor was open is not brought back by saving', () => {
  const l = loops.newLoop({ name: 'gone' })
  loops.upsertLoop(l)
  loops.removeLoop(l.id)
  assert.equal(loops.saveEditedLoop({ ...l, name: 'edited' }), false)
  assert.equal(loops.getLoops().some((x) => x.id === l.id), false)
})
