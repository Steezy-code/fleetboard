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
