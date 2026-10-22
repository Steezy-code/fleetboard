// The board saves itself; when a save fails the user hears about it instead of losing work silently.
import { ipc } from '../support/renderer-env'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
const { useApp } = await import('@/state/store')

const project = { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] }
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('changes are saved shortly after; a failing save is reported once in a while, not on every change', async () => {
  const saved: unknown[] = []
  ipc.handle('store:saveProject', (p: unknown) => saved.push(p))
  useApp.setState({ project: project as any, toasts: [] } as any)
  useApp.getState().addNode({ type: 'note', x: 0, y: 0 })
  mock.timers.tick(400)
  await flush()
  assert.equal(saved.length, 1)

  ipc.handle('store:saveProject', () => {
    throw new Error('ENOSPC: no space left on device')
  })
  useApp.getState().addNode({ type: 'note', x: 10, y: 0 })
  mock.timers.tick(400)
  await flush()
  const toasts = () => ((useApp.getState() as any).toasts ?? []).map((t: any) => t.text)
  assert.ok(toasts().some((t: string) => /Could not save the board: .*no space left/.test(t)), JSON.stringify(toasts()))
  const n = toasts().length
  useApp.getState().addNode({ type: 'note', x: 20, y: 0 })
  mock.timers.tick(400)
  await flush()
  assert.equal(toasts().length, n, 'not again right away')
})

test('a change to a workspace that is not the active one is saved too', async () => {
  // There was no action for this, so four places wrote useApp.setState directly: live state changed
  // and nothing was scheduled. Two of them then wrote a `fleetTouched` timestamp into every saved
  // board purely to trigger the save; the other two saved nothing, so a team's lead→worker wire and
  // a console's resume/fresh choice survived only if some unrelated edit followed.
  const saved: any[] = []
  ipc.handle('store:saveProject', (p: unknown) => saved.push(p))
  const two = {
    ...project,
    activeWorkspaceId: 'w',
    workspaces: [project.workspaces[0]!, { ...project.workspaces[0]!, id: 'bg', name: 'Background' }]
  }
  useApp.setState({ project: two as any, toasts: [] } as any)

  useApp.getState().mutateWsById('bg', (w) => ({ ...w, wires: [{ id: 'wire1', from: 'a', to: 'b' }] }))
  mock.timers.tick(400)
  await flush()
  assert.equal(saved.length, 1, 'scheduled a save')
  assert.deepEqual(saved[0].workspaces.find((w: any) => w.id === 'bg').wires, [{ id: 'wire1', from: 'a', to: 'b' }])
  assert.deepEqual(saved[0].workspaces.find((w: any) => w.id === 'w').wires, [], 'and left the active one alone')
  assert.equal('fleetTouched' in saved[0].extras, false, 'no marker written into the board to make that happen')

  // and the one that touches every workspace at once
  useApp.getState().mutateEveryWs((w) => ({ ...w, wires: [] }))
  mock.timers.tick(400)
  await flush()
  assert.equal(saved.length, 2)
  assert.deepEqual(
    saved[1].workspaces.map((w: any) => w.wires),
    [[], []]
  )
})
