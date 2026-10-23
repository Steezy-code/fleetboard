// The × on a workspace tab: running consoles are asked about, and everything else can be brought
// back with one Undo, at the place it had.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { closeWorkspaceAsking } = await import('@/chrome/closeWorkspace')

const ws = (id: string, nodes: unknown[] = []) => ({ id, name: id, nodes, groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} })

test('a workspace of notes closes at once, and Undo puts it back where it was', async () => {
  ipc.handle('store:saveProject', () => {})
  const note = { id: 'n1', type: 'note', x: 0, y: 0, w: 10, h: 10, z: 1, data: { text: 'keep me' } }
  useApp.setState({ toasts: [], confirms: [], live: {}, project: { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'a', lastOpened: 0, extras: {}, workspaces: [ws('a'), ws('plans', [note]), ws('c')] } } as never)
  await closeWorkspaceAsking('plans')
  assert.equal(useApp.getState().confirms.length, 0, 'nothing running: no question')
  assert.deepEqual(useApp.getState().project!.workspaces.map((w) => w.id), ['a', 'c'])
  const toast = useApp.getState().toasts.at(-1) as { action?: { run: () => void } }
  toast.action!.run()
  assert.deepEqual(useApp.getState().project!.workspaces.map((w) => w.id), ['a', 'plans', 'c'])
  assert.equal((useApp.getState().project!.workspaces[1]!.nodes[0] as { data: { text: string } }).data.text, 'keep me')
})
