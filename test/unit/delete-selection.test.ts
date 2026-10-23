// Delete on the board: the only question is asked before anything is removed, and one Undo brings
// back everything that went, group membership included.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { deleteSelection } = await import('@/board/deleteSelection')

const ws = () => useApp.getState().project!.workspaces[0]!
const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, w: 100, h: 100, z: 1, data: { name: id, agentId: 'claude' }, ...extra })

beforeEach(() => {
  ipc.handlers.clear()
  ipc.handle('store:saveProject', () => {})
  ipc.handle('pty:kill', () => {})
  useApp.setState({
    toasts: [],
    confirms: [],
    selection: [],
    live: { c1: true },
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
          nodes: [node('c1', 'console', { groupId: 'g1' }), node('n1', 'note'), node('n2', 'note', { groupId: 'g1' })],
          groups: [{ id: 'g1', name: 'Team', role: 'General', x: 0, y: 0, w: 300, h: 300 }],
          wires: [{ id: 'w1', from: 'n1', to: 'g1' }],
          ink: [{ id: 'i1', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }],
          camera: { x: 0, y: 0, zoom: 1 },
          extras: {}
        }
      ]
    }
  } as never)
})

test('Cancel on "close the running agent?" removes nothing at all', async () => {
  useApp.getState().setSelection(['c1', 'n1', 'g1', 'w1', 'i1'])
  const done = deleteSelection()
  await new Promise((r) => setTimeout(r, 10))
  const ask = useApp.getState().confirms[0] as { resolve: (ok: boolean) => void } | undefined
  assert.ok(ask, 'it asked about the live console')
  ask!.resolve(false)
  await done
  assert.deepEqual(ws().nodes.map((n) => n.id), ['c1', 'n1', 'n2'])
  assert.equal(ws().groups.length, 1, 'the group frame is still there')
  assert.equal(ws().wires.length, 1, 'and its wire')
  assert.equal(ws().ink.length, 1, 'and the drawing')
})

test('Undo brings back every tile, the group, its members and the wire', async () => {
  useApp.getState().setSelection(['n1', 'g1', 'i1'])
  await deleteSelection()
  assert.deepEqual(ws().nodes.map((n) => n.id).sort(), ['c1', 'n2'])
  assert.equal(ws().nodes.find((n) => n.id === 'n2')!.groupId, undefined, 'a member is let go with its group')
  assert.equal(ws().wires.length, 0, 'the wire goes with its ends')
  const toast = useApp.getState().toasts.at(-1) as { action?: { run: () => void } }
  assert.ok(toast?.action, 'the toast offers Undo')
  toast.action!.run()
  assert.deepEqual(ws().nodes.map((n) => n.id).sort(), ['c1', 'n1', 'n2'])
  assert.equal(ws().groups[0]?.id, 'g1')
  assert.equal(ws().nodes.find((n) => n.id === 'n2')!.groupId, 'g1', 'membership restored')
  assert.equal(ws().wires[0]?.id, 'w1')
  assert.equal(ws().ink[0]?.id, 'i1')
})
