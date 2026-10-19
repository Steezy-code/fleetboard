// Fleetboard runs all day: opening and closing panels, consoles and workspaces over and over must not
// pile up memory, DOM nodes, event listeners or processes, in the window or in the main process.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { App, makeRepo, makeSandbox } from './harness'

let app: App
before(async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'repo', { 'README.md': '# demo\n', 'src/a.ts': 'export const a = 1\n' })
  app = await App.launch({ sandbox: sb, mainInspector: true, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  await app.openProject(repo)
})
after(async () => {
  await app?.close()
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
async function counters() {
  const page = (app as any).cdp
  const mainHeap = async () => {
    await app.evalMain('1')
    await (app as any).main.send('HeapProfiler.collectGarbage')
    return app.evalMain<number>('process.memoryUsage().heapUsed')
  }
  for (let i = 0; i < 3; i++) await page.send('HeapProfiler.collectGarbage')
  const heap = await page.send('Runtime.getHeapUsage')
  const dom = await page.send('Memory.getDOMCounters')
  return { heap: heap.usedSize as number, nodes: dom.nodes as number, listeners: dom.jsEventListeners as number, main: await mainHeap(), ptys: (await app.invoke('pty:list')).length as number }
}
const MB = 1024 * 1024

/** Run `round` a few times to warm up, then many more: what is left over must not grow with the count. */
async function steady(what: string, round: () => Promise<void>, rounds: number) {
  await round()
  await round()
  const base = await counters()
  for (let i = 0; i < rounds; i++) await round()
  const end = await counters()
  const msg = `${what}: ${JSON.stringify({ base, end })}`
  assert.ok(end.heap - base.heap < 3 * MB, `window memory grew: ${msg}`)
  assert.ok(end.main - base.main < 4 * MB, `main-process memory grew: ${msg}`)
  assert.ok(end.nodes - base.nodes <= 30, `DOM nodes piled up: ${msg}`)
  assert.ok(end.listeners - base.listeners <= 10, `event listeners piled up: ${msg}`)
  assert.equal(end.ptys, base.ptys, `processes left running: ${msg}`)
}

test('every panel and drawer, opened and closed over and over', async () => {
  const kinds = await app.eval(() => ({ panel: Object.keys((window as any).__fleetboard.PANELS), drawer: Object.keys((window as any).__fleetboard.DRAWERS) }))
  await steady(
    'panels',
    async () => {
      for (const [kind, names] of Object.entries(kinds))
        for (const name of names) {
          await app.eval(({ k, n }) => (window as any).__fleetboard.useApp.getState()[k === 'panel' ? 'openPanel' : 'openDrawer'](n), { k: kind, n: name })
          await settle(150)
          await app.eval((k) => (window as any).__fleetboard.useApp.getState()[k === 'panel' ? 'closePanel' : 'closeDrawer'](), kind)
        }
      await settle()
    },
    5
  )
})

test('consoles started, used and closed over and over', async () => {
  await steady(
    'consoles',
    async () => {
      const ids: string[] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', count: 3 }))
      for (const id of ids) await app.waitStatus(id, 'idle')
      await app.eval((id) => (window as any).__fleetboard.sendToConsole(id, 'hello'), ids[0])
      await app.waitFor(async () => /ok/.test(await app.invoke('pty:tail', ids[0], 2000)), { label: 'reply' })
      await app.eval((ids) => (window as any).__fleetboard.killConsoles(ids, { confirm: false }), ids)
      await app.waitFor(async () => !(await app.invoke('pty:list')).some((p: any) => ids.includes(p.id)), { label: 'processes gone' })
      await settle(500)
    },
    6
  )
})

test('workspaces with running consoles, switched over and over', async () => {
  const wsA = await app.eval(() => (window as any).__fleetboard.useApp.getState().project.activeWorkspaceId)
  const ids: string[] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', count: 2 }))
  for (const id of ids) await app.waitStatus(id, 'idle')
  const wsB = await app.eval(() => (window as any).__fleetboard.useApp.getState().addWorkspace('B'))
  await steady(
    'workspaces',
    async () => {
      await app.eval((id) => (window as any).__fleetboard.useApp.getState().switchWorkspace(id), wsB)
      await settle(300)
      await app.eval((id) => (window as any).__fleetboard.useApp.getState().switchWorkspace(id), wsA)
      await settle(500)
    },
    8
  )
})
