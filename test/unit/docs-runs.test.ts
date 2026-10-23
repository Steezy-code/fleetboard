// The Documents studio saves what a run wrote as the document for its preset, replacing the last
// one. A run that failed partway must not get that far: the good document it would replace is the
// only copy.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { startDoc, useDocStudio, savedDocs } = await import('@/studios/docs/state')

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const proj = (id: string, docs: unknown[] = []) => ({
  schema: 1,
  id,
  name: id,
  path: '/tmp/' + id,
  activeWorkspaceId: 'w',
  lastOpened: 0,
  extras: { documents: docs },
  workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
})
const good = { id: 'doc1', preset: 'architecture', title: 'Architecture', markdown: '# Architecture\n\nThe whole, finished document.\n', createdAt: 1 }

/** cli:run answers when the test says so; chunks go out as cli:chunk, as main sends them */
function fakeCli() {
  let finish!: (r: { code: number; text: string }) => void
  let runId = ''
  ipc.handle('cli:run', (req: any) => {
    runId = req.runId
    return new Promise((r) => (finish = r))
  })
  return { chunk: (t: string) => ipc.emit('cli:chunk', runId, t), done: (r: { code: number; text: string }) => finish(r) }
}

for (const [how, result] of [
  ['exits 1', { code: 1, text: '# Architecture\n\nThe system has thr' }],
  ['reports an error in its result', { code: 1, text: 'Reached max turns' }]
] as const) {
  test(`a run that ${how} halfway keeps the last good document and shows the failure`, async () => {
    ipc.handle('store:saveProject', () => {})
    useApp.setState({ project: proj('A', [good]) as any, toasts: [] } as any)
    const cli = fakeCli()
    startDoc({ key: 'architecture', preset: 'architecture', agentId: 'claude', depth: 'balanced' })
    await flush()
    cli.chunk('# Architecture\n\nThe system has thr')
    cli.done(result)
    await flush()
    const docs = savedDocs(useApp.getState().project!.extras)
    assert.deepEqual(
      docs.map((d) => d.markdown),
      [good.markdown],
      'the finished document is still the saved one'
    )
    assert.equal(useDocStudio.getState().gens.architecture?.status, 'error')
  })
}
