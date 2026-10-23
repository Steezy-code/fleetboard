// Unsaved editor work is asked about before it would be dropped, and only then.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { mayDropUnsaved, setUnsaved } = await import('@/lib/unsaved')
void ipc

test('nothing unsaved: no question; something unsaved: asked, and the answer decides', async () => {
  useApp.setState({ confirms: [] } as never)
  assert.equal(await mayDropUnsaved('Quit'), true)
  assert.equal(useApp.getState().confirms.length, 0)

  setUnsaved('code', 'parser.ts')
  setUnsaved('skill', '/review')
  const asked = mayDropUnsaved('Quit')
  await new Promise((r) => setTimeout(r, 0))
  const c = useApp.getState().confirms[0] as { title: string; resolve: (ok: boolean) => void }
  assert.equal(c.title, 'Quit without saving parser.ts and /review?')
  c.resolve(false)
  assert.equal(await asked, false)

  setUnsaved('code', null)
  setUnsaved('skill', null)
  assert.equal(await mayDropUnsaved('Quit'), true, 'saved again: no question')
})

test('closing the project asks first, and a no keeps it open', async () => {
  ipc.handle('store:saveProject', () => {})
  ipc.handle('store:projects', () => [])
  const project = { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] }
  useApp.setState({ project: project as never, confirms: [] } as never)
  setUnsaved('code', 'parser.ts')
  const closing = useApp.getState().closeProject()
  await new Promise((r) => setTimeout(r, 0))
  const c = useApp.getState().confirms[0] as { title: string; resolve: (ok: boolean) => void }
  assert.equal(c.title, 'Close the project without saving parser.ts?')
  c.resolve(false)
  await closing
  assert.ok(useApp.getState().project, 'still open')
  setUnsaved('code', null)
})

test('switching project saves the board it replaces, and asks about unsaved work once', async () => {
  const saved: string[] = []
  ipc.handle('store:saveProject', (p: { id: string }) => void saved.push(p.id))
  ipc.handle('store:projectId', () => 'q')
  ipc.handle('store:loadProject', () => null)
  const board = (id: string, path: string) => ({ schema: 1, id, name: id, path, activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] })
  useApp.setState({ project: board('p', '/tmp/p') as never, confirms: [] } as never)
  setUnsaved('code', 'parser.ts')
  const opening = useApp.getState().openProject('/tmp/q')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(useApp.getState().confirms.length, 1, 'one question')
  ;(useApp.getState().confirms[0] as { resolve: (ok: boolean) => void }).resolve(true)
  await opening
  assert.equal(useApp.getState().project?.id, 'q')
  assert.ok(saved.includes('p'), 'the board it replaced was saved')
  setUnsaved('code', null)
})
