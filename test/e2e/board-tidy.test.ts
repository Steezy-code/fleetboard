// A long session's board, in the built app: new tiles land beside what is there instead of on it, a
// folded group hides its consoles without stopping or resizing them, Tidy packs the board and its
// Undo puts it back, and Clear finished takes away only the consoles that have ended.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

type R = { id: string; type?: string; groupId?: string; x: number; y: number; w: number; h: number }
const overlap = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
async function shot(app: App, name: string) {
  if (!process.env.E2E_SHOTS) return
  // the whole board in view, once the camera has finished moving
  await app.eval(() => (window as any).__fleetboard.useApp.getState().fitAll())
  await new Promise((r) => setTimeout(r, 700))
  await app.screenshot(path.join(process.env.E2E_SHOTS, `board-tidy-${name}.png`))
}

test('placement, folding, Tidy with Undo, and Clear finished', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    const fb = (fn: string, ...args: unknown[]) => app.eval(({ fn, args }) => (window as any).__fleetboard[fn](...args), { fn, args })
    const nodes = () => app.eval(() => (window as any).__fleetboard.activeWs().nodes.map((n: any) => ({ id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, groupId: n.groupId })) as R[])

    // a team of shells in a group, then more consoles and a tile without a position: nothing lands on anything
    const team = (await fb('spawnConsoles', { agentId: 'shell', count: 2, group: { name: 'Shells', role: 'Backend' } })) as string[]
    await fb('spawnConsoles', { agentId: 'shell', count: 2 })
    await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'note', w: 220, h: 200, data: { text: 'later' } }))
    const placed = await nodes()
    assert.equal(placed.length, 5)
    for (const a of placed) for (const b of placed) if (a !== b) assert.ok(!overlap(a, b), `${a.id} landed on ${b.id}`)
    await shot(app, '1-placed')

    // folded: hidden, not unmounted and not resized (the shell still reports the same size)
    const member = team[0]!
    await app.waitFor(async () => /\$|#|>/.test(await app.invoke('pty:tail', member, 400)), { label: 'shell prompt' })
    const size = async () => {
      await app.eval(({ id }) => (window as any).__fleetboard.sendToConsole(id, `stty size; echo SIZE-END`, true), { id: member })
      return app.waitFor(async () => /(\d+ \d+)\s*\r?\nSIZE-END/.exec(await app.invoke('pty:tail', member, 800))?.[1], { label: 'stty size' })
    }
    const before = await size()
    await app.click('.group .icon-btn[aria-expanded="true"]')
    await app.waitFor(async () => (await app.eval(({ id }) => getComputedStyle(document.querySelector(`[data-node-id="${id}"]`)!).visibility, { id: member })) === 'hidden', { label: 'member hidden' })
    assert.equal(await app.eval(() => (document.querySelector('.group') as HTMLElement).classList.contains('collapsed')), true)
    await new Promise((r) => setTimeout(r, 500))
    await app.invoke('pty:tail', member, 10)
    assert.equal(await size(), before, 'the folded console kept its size')
    await shot(app, '2-folded')
    await app.click('.group .icon-btn[aria-expanded="false"]')
    await app.waitFor(async () => (await app.eval(({ id }) => getComputedStyle(document.querySelector(`[data-node-id="${id}"]`)!).visibility, { id: member })) === 'visible', { label: 'member shown again' })

    // scatter the board, Tidy it, Undo it
    const ids = placed.filter((n) => !n.groupId).map((n) => n.id)
    await app.eval(({ ids }) => {
      const s = (window as any).__fleetboard.useApp.getState()
      ids.forEach((id: string, i: number) => s.updateNode(id, { x: 3000 * (i % 2) - 1500 + i * 137, y: 1800 * i - 900 }))
    }, { ids })
    const scattered = await nodes()
    await app.click('.chip', 'Tidy')
    const tidied = await app.waitFor(async () => {
      const now = await nodes()
      return now.some((n, i) => n.x !== scattered[i]!.x) ? now : null
    }, { label: 'tidied' })
    for (const a of tidied) for (const b of tidied) if (a !== b) assert.ok(!overlap(a, b), `${a.id} overlaps ${b.id} after Tidy`)
    const groupMembers = tidied.filter((n) => n.groupId)
    assert.equal(groupMembers.length, 2, 'the group kept its members')
    await shot(app, '3-tidied')
    await app.click('.toast button', 'Undo')
    await app.waitFor(async () => JSON.stringify(await nodes()) === JSON.stringify(scattered), { label: 'Undo put everything back' })

    // a console that has ended can be cleared; the running ones stay
    const ended = ((await fb('spawnConsoles', { agentId: 'shell', at: { x: -4000, y: -4000 } })) as string[])[0]!
    await app.waitFor(async () => /\$|#|>/.test(await app.invoke('pty:tail', ended, 400)), { label: 'shell prompt' })
    await app.eval(({ id }) => (window as any).__fleetboard.sendToConsole(id, 'exit', true), { id: ended })
    await app.waitStatus(ended, 'exited')
    await app.waitFor(async () => (await app.texts('.chip')).some((t) => t.includes('Clear 1 finished')), { label: 'Clear finished chip' })
    await app.click('.chip', 'Clear 1 finished')
    await app.click('.modal.confirm .btn', 'Remove')
    await app.waitFor(async () => !(await nodes()).some((n) => n.id === ended), { label: 'the ended console is gone' })
    assert.equal((await nodes()).filter((n) => n.type === 'console').length, 4, 'the running consoles stayed')
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})
