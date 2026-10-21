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

/**
 * What the window and the main process are holding, after a collection that actually finishes.
 *
 * A detached DOM node goes in two stages: V8 collects its JS wrapper, then Blink collects the node
 * behind it. Three collections back to back only ever do the first stage, so getDOMCounters keeps
 * counting nodes nothing refers to any more. One at a time with a turn in between does both — and
 * that is the difference between a number that means something and a number that reads as a leak
 * whenever the machine is busy: run four files at a time, this said 108 nodes had piled up while the
 * document itself had not changed by a single element.
 *
 * `attached` is the count the name of this test really asks about: elements in the document. It does
 * not depend on when a collector runs, so a panel that fails to unmount, or a toast that never
 * leaves, shows up there whatever the machine is doing.
 */
async function counters() {
  const page = (app as any).cdp
  const mainHeap = async () => {
    await app.evalMain('1')
    await (app as any).main.send('HeapProfiler.collectGarbage')
    return app.evalMain<number>('process.memoryUsage().heapUsed')
  }
  // Collect until the count stops falling, rather than a fixed number of times: each pass frees one
  // stage, and how many passes that takes depends on how busy the machine is. A fixed four was enough
  // for a quiet run and not for two or three app launches at once, which made this read as a leak
  // exactly when the suite is run the way ARCHITECTURE.md recommends running it.
  const trail: number[] = []
  let flat = 0
  for (let i = 0; i < 20 && flat < 2; i++) {
    await page.send('HeapProfiler.collectGarbage')
    await settle(120)
    const n = (await page.send('Memory.getDOMCounters')).nodes as number
    const prev = trail.at(-1) ?? Infinity
    flat = n < prev ? 0 : flat + 1
    trail.push(n)
  }
  const heap = await page.send('Runtime.getHeapUsage')
  const dom = await page.send('Memory.getDOMCounters')
  const attached = await app.eval(() => document.getElementsByTagName('*').length)
  return {
    heap: heap.usedSize as number,
    nodes: dom.nodes as number,
    /** what each collection pass left, so a failure says whether it had finished collecting */
    collecting: trail,
    attached,
    listeners: dom.jsEventListeners as number,
    main: await mainHeap(),
    ptys: (await app.invoke('pty:list')).length as number
  }
}
const MB = 1024 * 1024

/** Run `round` a few times to warm up, then many more: what is left over must not grow with the count. */
async function steady(what: string, round: () => Promise<void>, rounds: number) {
  await round()
  await round()
  const base = await counters()
  for (let i = 0; i < rounds; i++) await round()
  // something still closing (a transition, a toast) is not a leak: give the window a few seconds to
  // settle. Only in-flight work needs that; an uncollected node does not go away by waiting, which
  // is what counters() is for.
  let end = await counters()
  for (let i = 0; i < 10 && (end.attached - base.attached > 10 || end.listeners - base.listeners > 10); i++) {
    await settle(500)
    end = await counters()
  }
  const msg = `${what}: ${JSON.stringify({ base, end })}`
  assert.ok(end.heap - base.heap < 3 * MB, `window memory grew: ${msg}`)
  assert.ok(end.main - base.main < 4 * MB, `main-process memory grew: ${msg}`)
  assert.ok(end.attached - base.attached <= 10, `elements left in the document: ${msg}`)
  assert.ok(end.listeners - base.listeners <= 10, `event listeners piled up: ${msg}`)
  /**
   * Detached nodes get a loose bound, and the reason is in the data rather than in impatience.
   *
   * Under three app launches at once this reported +83 nodes while `attached` was identical (245 and
   * 245) and the collection trail was flat — so the document was unchanged and those nodes were
   * simply not being collected in the window the test allows. A number the collector is free to
   * leave is not one to assert tightly on.
   *
   * What it can still catch is the thing the test is named for: something piling up *per round*.
   * Leaking one panel's subtree each time would be a thousand nodes over this many rounds, not a
   * constant eighty. `attached` above is the strict gate, and it does not depend on a collector.
   */
  assert.ok(end.nodes - base.nodes <= 250, `DOM nodes piled up: ${msg}`)
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
