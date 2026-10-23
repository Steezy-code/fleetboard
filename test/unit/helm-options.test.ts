// What an Oracle option does is what its card says, and words bound for a console that acts on them
// without asking (a shell, an agent that approves everything) wait for an explicit yes.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { describe } = await import('@/voice/actions')
const { runHelmOption, useHelm } = await import('@/voice/helm/helm')

test('a spawn’s prompt and a handoff’s note are part of the step as shown', () => {
  assert.match(describe({ type: 'spawn', agent: 'claude', count: 1, prompt: 'delete the old migrations' }), /delete the old migrations/)
  assert.match(describe({ type: 'handoff', from: [], toAgent: 'codex', note: 'push to main when done' }), /push to main when done/)
})

test('an Oracle send into a shell console types nothing until the user says yes', async () => {
  ipc.handle('store:saveProject', () => {})
  ipc.handle('journal:append', () => {})
  useApp.setState({
    confirms: [],
    live: { s1: true },
    statuses: { s1: 'idle' },
    settings: { ...useApp.getState().settings, speakReplies: false },
    project: {
      schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {},
      workspaces: [{ id: 'w', name: 'W', nodes: [{ id: 's1', type: 'console', x: 0, y: 0, w: 1, h: 1, z: 1, data: { name: 'devserver', agentId: 'shell' } }], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
    }
  } as never)
  useHelm.setState({ card: { id: 'h', request: 'restart it', source: 'typed', reply: '', options: [{ kind: 'send', label: 'Restart the dev server', detail: 'restarts it', targets: ['devserver'], text: 'rm -rf build', submit: true }], ran: null } as never })
  ipc.sent.length = 0
  const run = runHelmOption(0)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ipc.sent.filter((s) => s.channel === 'pty:paste' || s.channel === 'pty:send').length, 0, 'nothing typed yet')
  const ask = useApp.getState().confirms[0] as { body?: string; resolve: (ok: boolean) => void }
  assert.match(ask.body ?? '', /rm -rf build/, 'the question shows the words that would run')
  ask.resolve(false)
  await run
  assert.equal(ipc.sent.filter((s) => s.channel === 'pty:paste' || s.channel === 'pty:send').length, 0, 'and nothing after a no')
})
