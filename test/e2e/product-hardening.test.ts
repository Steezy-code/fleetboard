import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App, makeRepo, makeSandbox } from './harness'

test('first-team guide drafts without starting work, and persists dismissal', async () => {
  const sb = makeSandbox(); const repo = makeRepo(sb, 'repo', { 'README.md': '# repo' })
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    await app.click('.team-guide button', 'Draft a first goal')
    assert.match(await app.eval(() => (document.querySelector('.command-bar input') as HTMLInputElement).value), /one small bug/)
    assert.equal((await app.invoke('pty:list')).length, 0)
    await app.click('.team-guide button', 'Dismiss')
    assert.equal(await app.eval(() => document.querySelector('.team-guide')), null)
    assert.equal(await app.eval(() => (window as any).__fleetboard.useApp.getState().project.extras.teamGuideDismissed), true)
  } finally { await app.close() }
})

test('settings dialogs contain focus, announce switches, and return focus on Escape', async () => {
  const app = await App.launch({ sandbox: makeSandbox() })
  try {
    await app.eval(() => { const b = document.querySelector('.home-top button') as HTMLButtonElement; b.focus(); b.click() })
    await app.waitFor(() => app.eval(() => !!document.querySelector('[role=dialog]')), { label: 'accessible dialog' })
    assert.equal(await app.eval(() => document.querySelector('[role=dialog]')?.contains(document.activeElement)), true)
    const semantics = await app.eval(() => [...document.querySelectorAll('[role=switch]')].map((e) => e.getAttribute('aria-checked')))
    assert.ok(semantics.length > 0); assert.ok(semantics.every((v) => v === 'true' || v === 'false'))
    await app.eval(() => { const buttons = [...document.querySelectorAll<HTMLElement>('[role=dialog] button')].filter((e) => e.getClientRects().length && !e.matches(':disabled')); buttons.at(-1)?.focus(); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    assert.equal(await app.eval(() => document.querySelector('[role=dialog]')?.contains(document.activeElement)), true)
    await app.eval(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await app.waitFor(() => app.eval(() => !document.querySelector('[role=dialog]')), { label: 'closed' })
    assert.equal(await app.eval(() => document.activeElement === document.querySelector('.home-top button')), true)
  } finally { await app.close() }
})

test('snapshot replacement previews content, preserves current board, and rejects traversal', async () => {
  const sb = makeSandbox(); const repo = makeRepo(sb, 'repo', { 'README.md': '# repo' })
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    await app.eval(async () => { const a = (window as any).__fleetboard.useApp.getState(); a.addNode({ type: 'note', data: { text: 'snapshot content' } }); await window.fb.invoke('store:saveProject', (window as any).__fleetboard.useApp.getState().project) })
    const snapshots = await app.invoke('recovery:list')
    assert.ok(snapshots.length)
    await assert.rejects(() => app.invoke('recovery:preview', '../app.json'))
    const preview = await app.invoke('recovery:preview', snapshots[0].id)
    await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'note', data: { text: 'current content' } }))
    await app.eval(async (token) => (window as any).__fleetboard.useApp.getState().recoverBoard(token), preview.token)
    const retained = await app.invoke('recovery:list')
    assert.ok(retained.length > snapshots.length)
    await assert.rejects(() => app.invoke('recovery:apply', preview.token), /expired/)
    assert.deepEqual(app.rendererErrors, [])
  } finally { await app.close() }
})

test('offscreen terminals stay mounted, receive output and become visible on focus', async () => {
  const sb = makeSandbox(); const repo = makeRepo(sb, 'repo', { 'README.md': '# repo' })
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'shell' })[0])
    await app.waitFor(async () => (await app.invoke('pty:list')).some((p: any) => p.id === id), { label: 'shell running' })
    await app.eval((id) => (window as any).__fleetboard.useApp.getState().updateNode(id, { x: 10000 }), id)
    await app.waitFor(() => app.eval((id) => (document.querySelector(`[data-node-id="${id}"]`) as HTMLElement)?.style.contentVisibility === 'hidden', id), { label: 'offscreen paint skipped' })
    await app.eval((id) => (window as any).__fleetboard.sendToConsole(id, "printf '\\150\\151\\144\\144\\145\\156\\137\\157\\153\\n'", true), id)
    await app.waitFor(async () => /hidden_ok/.test(await app.invoke('pty:tail', id, 2000)), { label: 'hidden terminal output' })
    await app.eval((id) => (window as any).__fleetboard.useApp.getState().enterFocus(id), id)
    await app.waitFor(() => app.eval((id) => (document.querySelector(`[data-node-id="${id}"]`) as HTMLElement)?.style.contentVisibility !== 'hidden', id), { label: 'focused terminal visible' })
    assert.equal((await app.invoke('pty:list')).length, 1)
  } finally { await app.close() }
})
