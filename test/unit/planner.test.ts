// The command bar's instant, offline parser and its safety rule: anything that closes consoles or
// messages many at once waits for "confirm".
import '../support/renderer-env'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { parseLocal } = await import('@/voice/planner')
const { confirmReasons } = await import('@/voice/actions')

const NAMES = ['Maya', 'Rafa', 'Dax', 'Nova', 'Iris', 'Theo', 'Juno', 'Kai']

before(() => {
  const node = (name: string, i: number) => ({ id: `c${i}`, type: 'console', x: i * 800, y: 0, w: 780, h: 440, z: i, groupId: i < 2 ? 'g1' : undefined, data: { name, agentId: 'claude' } })
  useApp.setState({
    project: {
      schema: 1,
      id: 'p',
      name: 'p',
      path: '/tmp/p',
      activeWorkspaceId: 'w',
      lastOpened: 0,
      extras: {},
      workspaces: [
        {
          id: 'w',
          name: 'W',
          nodes: NAMES.map(node),
          groups: [{ id: 'g1', name: 'Backend', role: 'Backend', x: 0, y: 0, w: 1600, h: 500 }],
          wires: [],
          ink: [],
          camera: { x: 0, y: 0, zoom: 1 },
          extras: {}
        }
      ]
    } as any,
    live: Object.fromEntries(NAMES.map((_, i) => [`c${i}`, true])),
    statuses: Object.fromEntries(NAMES.map((_, i) => [`c${i}`, 'idle'])),
    agents: [{ id: 'claude', installed: true }, { id: 'codex', installed: true }] as any
  })
})

const plan = (text: string) => parseLocal(text)
const confirmFor = (text: string) => {
  const p = plan(text)
  assert.ok(p, `"${text}" is understood locally`)
  return confirmReasons(p!.actions, text, false)
}

test('closing consoles always waits for confirm', () => {
  for (const text of ['close maya', 'kill everyone', 'close all consoles', 'shut down rafa and dax', 'get rid of nova']) {
    const p = plan(text)
    assert.equal(p?.actions[0]?.type, 'kill', text)
    assert.ok(confirmFor(text).includes('closes consoles'), text)
  }
})

test('deleting a team with live members waits for confirm', () => {
  const p = plan('delete the backend group')
  assert.deepEqual(p?.actions, [{ type: 'deleteTeam', team: 'g1' }])
  assert.deepEqual(confirmFor('delete the backend group'), ['closes live consoles'])
})

test('messaging more than six consoles waits for confirm; a few go straight through', () => {
  assert.deepEqual(confirmFor('tell everyone to run the tests'), ['messages more than 6 consoles'])
  assert.deepEqual(confirmFor('tell maya and rafa to run the tests'), [])
  const p = plan('tell maya and rafa to run the tests')
  assert.deepEqual(p?.actions[0], { type: 'send', targets: ['maya', 'rafa'], text: 'run the tests', submit: true })
})

test('harmless board commands run at once', () => {
  assert.deepEqual(plan('pause all')?.actions, [{ type: 'pause', targets: ['all'] }])
  assert.deepEqual(confirmFor('pause all'), [])
  assert.deepEqual(confirmFor('zoom out'), [])
  assert.equal(plan('spawn 3 codex')?.actions[0]?.type, 'spawn')
  assert.deepEqual(confirmFor('spawn 3 codex'), [])
  assert.deepEqual(confirmFor('spawn 12 claude'), ['spawns 12 consoles'])
})

test('a planner (model) step the user did not ask for is flagged', () => {
  const r = confirmReasons([{ type: 'send', targets: ['maya'], text: 'git push --force', submit: true }], 'what is maya doing', true)
  assert.ok(r.some((x) => /didn't ask for \(send\)/.test(x)), r.join())
  assert.deepEqual(confirmReasons([{ type: 'send', targets: ['maya'], text: 'status?', submit: true }], 'ask maya for a status', true), [])
})

test('work requests are not mistaken for board commands', () => {
  for (const text of ['add a dark mode toggle to the settings page', 'fix the failing login test', 'remove the unused imports in src/utils']) {
    const p = plan(text)
    assert.ok(!p || !p.actions.some((a) => a.type === 'kill' || a.type === 'deleteTeam'), `${text} → ${JSON.stringify(p)}`)
  }
})

test('a parked "close" plan: only a plain yes runs it, a "no" anywhere cancels it, and it stays in its project', async () => {
  const { ipc } = await import('../support/renderer-env')
  const { confirmPending, runCommand } = await import('@/voice/planner')
  const { useVoice } = await import('@/voice/thread')
  ipc.handle('pty:kill', () => {})
  ipc.handle('store:saveProject', () => {})
  ipc.handle('journal:append', () => {})
  useApp.setState((st) => ({ settings: { ...st.settings, speakReplies: false, confirmKill: false } }))
  const g = globalThis as { SpeechSynthesisUtterance?: unknown; speechSynthesis?: unknown }
  g.SpeechSynthesisUtterance ??= class {}
  g.speechSynthesis ??= { speak() {}, cancel() {}, getVoices: () => [] }
  const kills = () => ipc.callsTo('pty:kill').length
  const park = async () => {
    await runCommand('close maya', 'typed')
    assert.ok(useVoice.getState().pending, 'closing waits for a yes')
  }

  await park()
  await runCommand('okay, cancel that', 'typed')
  assert.equal(useVoice.getState().pending, null)
  assert.equal(kills(), 0, '"okay, cancel that" is a no')

  await park()
  await runCommand('zoom out', 'typed')
  assert.equal(useVoice.getState().pending, null, 'anything else drops it')
  assert.equal(kills(), 0, 'and is not a yes')

  await park()
  const home = useApp.getState().project
  useApp.setState({ project: { ...home!, id: 'other' } as never })
  await confirmPending() // the confirm button, or "confirm" said in the other project
  assert.equal(kills(), 0, 'a plan asked in one project is not run in another')
  useApp.setState({ project: home })

  await park()
  await runCommand('confirm please', 'typed')
  assert.equal(kills(), 1, 'a plain yes runs it')
})

test('spoken answers: a plain yes or no answers a permission card, but never merges or discards a team', async () => {
  const { inboxPick } = await import('@/voice/planner')
  const { useInbox } = await import('@/fleet/inboxModel')
  const card = (kind: string, actions: { label: string; primary?: boolean; tone?: string }[]) =>
    useInbox.setState({ items: [{ key: 'k', kind, who: 'x', sub: '', since: 0, actions } as never], front: 'k' })
  card('approval', [{ label: 'Allow once', primary: true }, { label: 'Deny', tone: 'deny' }])
  assert.equal(inboxPick('okay'), 0)
  assert.equal(inboxPick('no'), 1)
  card('ready', [{ label: 'Merge', primary: true }, { label: 'View diff' }, { label: 'Discard', tone: 'deny' }])
  assert.equal(inboxPick('okay'), null, '"okay" is not "merge"')
  assert.equal(inboxPick('no'), null, '"no" is not "discard"')
  assert.equal(inboxPick('merge'), 0, 'saying the button does it')
  useInbox.setState({ items: [], front: null })
})

test('panels by name: the night log and the sweep can be asked for, and a panel that does not exist is not "opened"', async () => {
  const { panelFor } = await import('@/voice/actions')
  assert.deepEqual(panelFor('the night log'), { name: 'journal', drawer: true })
  assert.deepEqual(panelFor('journal'), { name: 'journal', drawer: true })
  assert.deepEqual(panelFor('morning sweep'), { name: 'sweep' })
  assert.deepEqual(panelFor('fleetDiff'), { name: 'fleetDiff', drawer: false })
  assert.equal(panelFor('spaceship'), null)
})
