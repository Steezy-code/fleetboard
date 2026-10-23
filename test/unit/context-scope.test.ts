// Oracle's snapshot of the board: it reads the charter and the live work, and with a board selection
// it is only what the user pointed at — so a question about two consoles and a card is answered about
// those three things.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCharter } from '@shared/charter'
import { emptyFleet, type FleetState } from '@shared/fleet'

const { useApp } = await import('@/state/store')
const { useFleet } = await import('@/engine/fleet')
const { setActivity } = await import('@/engine/activity')
const { boardContext, selectionScope } = await import('@/voice/helm/context')

const MIN = 60_000

const consoleNode = (id: string, name: string, x = 0) => ({ id, type: 'console', x, y: 0, w: 780, h: 440, z: 1, data: { agentId: 'claude', name, cwd: '/tmp/p' } })

function board(selection: string[] = [], groups: any[] = []) {
  const nodes = [
    consoleNode('c1', 'Ada'),
    consoleNode('c2', 'Bo', 800),
    consoleNode('c3', 'Cy', 1600),
    { ...consoleNode('c4', 'Di', 2400), groupId: 'g1' },
    { id: 'k1', type: 'kanban', title: 'Sprint', x: 0, y: 600, w: 400, h: 300, z: 1, data: { columns: [{ title: 'Doing', cards: [{ title: 'Split PDF command' }] }] } },
    { id: 'n1', type: 'note', x: 500, y: 600, w: 200, h: 200, z: 1, data: { text: 'remember the milk' } },
    { id: 'l1', type: 'checklist', x: 800, y: 600, w: 200, h: 200, z: 1, data: { title: 'Release', items: [{ text: 'tag it', done: false }] } }
  ]
  useApp.setState({
    project: {
      schema: 1,
      id: 'p',
      name: 'demo',
      path: '/tmp/p',
      activeWorkspaceId: 'w',
      lastOpened: 0,
      extras: {},
      workspaces: [{ id: 'w', name: 'Main', nodes, groups, wires: [{ id: 'wire1', from: 'c1', to: 'c2' }], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
    } as any,
    selection,
    live: { c1: true, c2: true, c3: true, c4: true },
    statuses: { c1: 'working', c2: 'idle', c3: 'working', c4: 'idle' }
  })
}

const TAILS: Record<string, string> = { c1: 'ada was editing the parser', c2: 'bo ran the tests', c3: 'cy is refactoring billing', c4: 'di wrote docs' }

beforeEach(() => {
  ipc.reset()
  ipc.handle('pty:tail', (id: string) => TAILS[id] ?? '')
  ipc.handle('git:status', () => ({ ok: true, status: { branch: 'main', files: [{ code: 'M', path: 'src/billing.ts' }] } }))
  ipc.handle('sweep:last', () => null)
  useFleet.setState({ state: null })
})

function team(): FleetState {
  const s = emptyFleet('p', '/tmp/p')
  const now = Date.now()
  const base = { agentId: 'claude', projectId: 'p', cwd: '/tmp/wt', status: 'working' as const }
  s.members = {
    lead: { ...base, id: 'lead', role: 'lead', name: 'Lead', createdAt: now - 14 * MIN, branch: 'fleet/split', lastOutputAt: now },
    c1: { ...base, id: 'c1', role: 'worker', name: 'Ada', leadId: 'lead', task: 'Write the parser', createdAt: now - 10 * MIN, lastOutputAt: now - 7 * MIN, diff: { files: 2, add: 40, del: 2, at: now } },
    c3: { ...base, id: 'c3', role: 'worker', name: 'Cy', leadId: 'lead', task: 'Refactor billing', createdAt: now - 10 * MIN, lastOutputAt: now }
  }
  s.tasks = [
    { id: 't1', title: 'Write the parser', owner: 'c1', status: 'doing', startedAt: now - 12 * MIN, estimate: 5 },
    { id: 't2', title: 'Refactor billing', owner: 'c3', status: 'doing', startedAt: now - 3 * MIN }
  ]
  s.charter = coerceCharter({ understood: 'Add a Split PDF command with tests', wontTouch: ['src/renderer/'], doneWhen: 'npm test', estimate: 30 }, 'add split pdf')
  s.check = { command: 'npm test', runs: [{ at: 1, code: 1, failing: 11 }, { at: 2, code: 1, failing: 3 }] }
  return s
}

// ---------------------------------------------------------------- the charter and the live work

test('Oracle reads what the job was agreed to be, and how its check is going', async () => {
  board()
  useFleet.setState({ state: team() })
  const ctx = await boardContext()
  assert.match(ctx, /charter \(what the user confirmed the job is\): Add a Split PDF command with tests/)
  assert.match(ctx, /won't touch: src\/renderer\//)
  assert.match(ctx, /done when: npm test · 3 failing, down from 11/)
  assert.match(ctx, /time: 14 min, est 30 min/)
})

test('each member says what it is doing, for how long against its estimate, how quiet it is and what it has changed', async () => {
  board()
  useFleet.setState({ state: team() })
  setActivity('c1', 'editing `src/cli/split.ts`')
  try {
    const ctx = await boardContext()
    assert.match(ctx, /Ada \(worker, working, under Lead, editing `src\/cli\/split\.ts`, silent 7 min, changed so far: 2 files \+40 −2: Write the parser\)/)
    assert.match(ctx, /1\. \[doing\] Write the parser \(Ada\) · 12 min, est 5 min/)
    assert.match(ctx, /## Ada \(claude · working · editing `src\/cli\/split\.ts` · worker/)
  } finally {
    setActivity('c1', null)
  }
})

// ---------------------------------------------------------------- point and ask

test('with nothing selected the snapshot is the whole board', async () => {
  board()
  assert.equal(selectionScope(), null)
  const ctx = await boardContext()
  for (const name of ['## Ada', '## Bo', '## Cy', '## Di']) assert.ok(ctx.includes(name), name)
  assert.match(ctx, /remember the milk/)
  assert.match(ctx, /git: branch main/)
})

test('two consoles and a card selected: the snapshot is those three, and says so', async () => {
  board(['c1', 'c2', 'k1'])
  useFleet.setState({ state: team() })
  const ctx = await boardContext()
  assert.match(ctx, /scope: the user selected Ada, Bo, kanban "Sprint" on the board and is asking about them/)
  assert.match(ctx, /## Ada/)
  assert.match(ctx, /## Bo/)
  assert.match(ctx, /ada was editing the parser/)
  assert.match(ctx, /Split PDF command/, 'the card’s contents')
  for (const gone of ['## Cy', '## Di', 'cy is refactoring billing', 'Refactor billing', 'remember the milk', 'Release', 'src/billing.ts', 'CI AND PULL REQUESTS'])
    assert.ok(!ctx.includes(gone), `${gone} is not part of what was pointed at`)
  // Ada is on the team, so the job she is working to comes with her
  assert.match(ctx, /charter \(what the user confirmed the job is\)/)
  assert.match(ctx, /TEAM \(the selected members only\)/)
})

test('the selected consoles get the room the rest of the board would have used', async () => {
  board(['c1'])
  TAILS.c1 = 'x'.repeat(4000)
  try {
    const scoped = await boardContext()
    board()
    const whole = await boardContext()
    const tailIn = (ctx: string) => /## Ada[^\n]*\n(.*)/.exec(ctx)?.[1]?.length ?? 0
    assert.ok(tailIn(scoped) > tailIn(whole) * 3, `${tailIn(scoped)} vs ${tailIn(whole)}`)
  } finally {
    TAILS.c1 = 'ada was editing the parser'
  }
})

// Review Focus 6
test('a selected group counts as its members; a selection of only a wire is no selection', async () => {
  board(['g1'], [{ id: 'g1', name: 'Docs', role: 'General', x: 0, y: 0, w: 10, h: 10 }])
  const ctx = await boardContext()
  assert.match(ctx, /scope: the user selected Di on the board and is asking about it/)
  assert.ok(!ctx.includes('## Ada'))
  board(['wire1'])
  assert.equal(selectionScope(), null)
  assert.match(await boardContext(), /## Cy/, 'the whole board')
})

test('a selection of a tile alone leaves every console out', async () => {
  board(['n1'])
  const ctx = await boardContext()
  assert.match(ctx, /scope: the user selected note on the board/)
  assert.match(ctx, /remember the milk/)
  assert.match(ctx, /\(no consoles selected\)/)
  assert.ok(!ctx.includes('## Ada'))
})
