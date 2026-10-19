// The window's page crashes (out of memory, a GPU fault): it comes back by itself, on the same board,
// with the consoles that kept running in the meantime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

test('after the window crashes it reloads onto the same board, and the running consoles are still there', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    await app.waitStatus(id, 'idle')
    assert.equal(await app.invoke('pty:deliver', id, 'before the crash'), true)
    await app.waitFor(() => app.fakeLog((e) => e.event === 'prompt' && e.prompt === 'before the crash').length > 0, { label: 'prompt typed' })
    const [before] = await app.invoke('pty:list')
    await app.crashWindow()

    await app.waitFor(() => app.eval(() => !!(window as any).__fleetboard?.useApp.getState().project).catch(() => false), { timeout: 20_000, label: 'board back' })
    assert.equal(await app.eval(() => (window as any).__fleetboard.useApp.getState().project.path), repo)
    const toast = await app.waitFor(async () => (await app.texts('.toast')).find((t) => /crashed and was reloaded/.test(t)), { label: 'toast' })
    assert.match(toast, /Your consoles kept running/)
    // the same process, picked up again: its screen and status, and it still takes input
    const [after] = await app.invoke('pty:list')
    assert.equal(after.pid, before.pid)
    await app.waitFor(async () => (await app.eval((id) => !!(window as any).__fleetboard.useApp.getState().live[id], id)), { label: 'console live' })
    assert.match(String(await app.invoke('pty:buffer', id)), /before the crash/)
    assert.equal(await app.invoke('pty:deliver', id, 'after the crash'), true)
    await app.waitFor(() => app.fakeLog((e) => e.event === 'prompt' && e.prompt === 'after the crash').length > 0, { label: 'prompt after the crash' })
    assert.equal(app.fakeLog((e) => e.event === 'start').length, 1, 'never restarted')
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'crash.png')).catch(() => {})
    await app.close()
  }
})
