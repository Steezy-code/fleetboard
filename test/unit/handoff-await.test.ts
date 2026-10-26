// A handoff writes its brief with a model run, often tens of seconds long. The board can change
// meanwhile, and what happens after the brief is decided by the board as it is then, not as it was.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { handoff } = await import('@/engine/handoff')

const ws = (id: string, nodes: unknown[] = []) => ({ id, name: id, nodes, groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} })
const source = { id: 'src', type: 'console', x: 0, y: 0, w: 780, h: 440, z: 1, data: { name: 'Maya', agentId: 'claude' } }
const project = (id: string, active = 'w1') => ({ schema: 1, id, name: id, path: `/tmp/${id}`, activeWorkspaceId: active, lastOpened: 0, extras: {}, workspaces: [ws('w1', id === 'p' ? [source] : []), ws('w2')] })

beforeEach(() => {
  ipc.reset()
  ipc.handle('pty:tail', () => 'did some work')
  ipc.handle('store:saveProject', () => {})
  useApp.setState({ project: project('p') as never, live: { src: true }, statuses: {}, toast: () => {} } as never)
})

test('another project opened while the brief is written: nothing is handed off into it', async () => {
  ipc.handle('cli:run', async () => {
    useApp.setState({ project: project('other') as never })
    return { code: 0, text: 'the brief' }
  })
  await assert.rejects(handoff({ fromIds: ['src'], toAgentId: 'claude' }), /Another project was opened/)
  assert.equal(useApp.getState().project?.id, 'other')
  assert.equal(useApp.getState().project?.activeWorkspaceId, 'w1', 'its workspace is left alone, not switched to an id from the old one')
})

test('the source closed while the brief is written: said, not spawned somewhere stale', async () => {
  ipc.handle('cli:run', async () => {
    const p = useApp.getState().project!
    useApp.setState({ project: { ...p, workspaces: p.workspaces.map((w) => ({ ...w, nodes: [] })) } as never })
    return { code: 0, text: 'the brief' }
  })
  await assert.rejects(handoff({ fromIds: ['src'], toAgentId: 'claude' }), /no longer on the board/)
})
