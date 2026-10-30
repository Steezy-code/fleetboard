import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App, makeRepo, makeSandbox } from './harness'

test('motion preferences, directional traffic, activation, Tidy and focus', async () => {
  const sb = makeSandbox()
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(makeRepo(sb))
    await app.eval(async () => {
      const s = (window as any).__fleetboard.useApp.getState()
      await s.setSettings({ motion: 'full' })
      s.addNode({ id: 'motion-a', type: 'note', x: 50, y: 60, w: 240, h: 180, data: { text: 'Lead' } })
      s.addNode({ id: 'motion-b', type: 'note', x: 420, y: 60, w: 240, h: 180, data: { text: 'Worker' } })
      s.addNode({ id: 'motion-c', type: 'note', x: 1200, y: 900, w: 240, h: 180, data: { text: 'Independent' } })
      s.addWire('motion-a', 'motion-b')
    })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'full'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    await app.eval(() => (window as any).__fleetboard.useApp.getState().enterFocus('motion-a'))
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="motion-a"]')!.getAnimations().some((a) => a instanceof CSSTransition)), { label: 'focus size transition' })
    await app.eval(() => (window as any).__fleetboard.useApp.getState().exitFocus())
    assert.equal(await app.eval(() => document.querySelectorAll('.wire-message').length), 0, 'idle wires do not pulse')
    // Wait until the SVG clock is well past zero: late messages must still animate.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await app.eval(() => (window as any).__fleetboard.useFleet.setState({ hot: { 'motion-b>motion-a': Date.now() + 1800 } }))
    await app.waitFor(() => app.eval(() => {
      const pulse = document.querySelector('.wire-pulse')
      return pulse && Number(getComputedStyle(pulse).opacity) > 0.1
    }), { label: 'late message is visibly moving' })
    assert.ok(await app.eval(() => {
      const path = document.querySelector('animateMotion')!.getAttribute('path')!
      return Number(path.match(/^M([\d.]+)/)![1]) > 400
    }), 'reverse message starts at the worker')
    await app.eval(async () => { await (window as any).__fleetboard.useApp.getState().setSettings({ motion: 'off' }) })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'off' && !document.querySelector('.wire-message')))
    assert.equal(await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.enterFocus('motion-a')
      return (window as any).__fleetboard.activeWs().camera.zoom
    }), 1, 'off lands the focus camera synchronously')
    assert.equal(await app.eval(() => getComputedStyle(document.querySelector('[data-node-id="motion-a"]')!).transitionDuration), '0s')
    await app.eval(async () => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.exitFocus()
      await s.setSettings({ motion: 'full' })
    })
    const before = await app.eval(() => (window as any).__fleetboard.activeWs().nodes.map((n: any) => [n.id, n.x, n.y]))
    await app.click('.chip', 'Tidy')
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="motion-c"]')!.getAnimations().length > 0), { label: 'Tidy animates the card' })
    await app.click('.toast button', 'Undo')
    assert.deepEqual(await app.eval(() => (window as any).__fleetboard.activeWs().nodes.map((n: any) => [n.id, n.x, n.y])), before, 'Undo restores exact persisted positions, even during motion')
    await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      // A shell tile exercises the real console frame without running an AI agent.
      s.addNode({ id: 'motion-console', type: 'console', x: 40, y: 300, w: 500, h: 260, data: { agentId: 'shell', name: 'Motion check', cwd: s.project.path, createdAt: Date.now() } })
      s.setStatus('motion-console', 'idle')
    })
    await app.waitFor(() => app.eval(() => !!document.querySelector('[data-node-id="motion-console"]')))
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setStatus('motion-console', 'working'))
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="motion-console"]')!.classList.contains('agent-activating')), { label: 'agent activation' })
    // Test the system override as a live media-query change, as well as persisted selection.
    await (app as any).cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'off'))
    assert.equal(await app.invoke('store:settings').then((s: any) => s.motion), 'full', 'system override preserves the saved choice')
    await (app as any).cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'full'))
    await app.eval(async () => {
      const s = (window as any).__fleetboard.useApp.getState()
      await s.setSettings({ motion: 'subtle' })
      s.openPanel('settings')
    })
    await app.waitFor(() => app.eval(() => !!document.querySelector('#motion-setting')))
    await app.eval(() => document.querySelector('#motion-setting')!.scrollIntoView({ block: 'center', behavior: 'instant' }))
    assert.equal(await app.eval(() => (document.querySelector('#motion-setting') as HTMLSelectElement).value), 'subtle')
    if (process.env.E2E_SHOTS) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await app.screenshot(`${process.env.E2E_SHOTS}/motion.png`)
    }
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})

test('terminal entrance, attention, group folding, docking, Oracle and completion cascade', async () => {
  const sb = makeSandbox()
  const app = await App.launch({ sandbox: sb })
  const cdp = (app as any).cdp
  try {
    await app.openProject(makeRepo(sb))
    await app.eval(async () => {
      const s = (window as any).__fleetboard.useApp.getState()
      await s.setSettings({ motion: 'off' })
      s.setCamera({ x: 0, y: 0, zoom: 1 })
      s.addGroup({ id: 'dock-group', name: 'Motion team', role: 'Backend', x: 600, y: 150, w: 420, h: 500 })
      s.addNode({ id: 'dock-card', type: 'checklist', x: 100, y: 200, w: 280, h: 200, data: { items: [] } })
    })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'off' && !!document.querySelector('[data-node-id="dock-card"]')))
    await app.eval(async () => { await (window as any).__fleetboard.useApp.getState().setSettings({ motion: 'full' }) })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'full'))
    await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ id: 'new-terminal', type: 'console', groupId: 'dock-group', x: 640, y: 350, w: 340, h: 240, data: { agentId: 'shell', name: 'New terminal', cwd: (window as any).__fleetboard.useApp.getState().project.path, createdAt: Date.now() } }))
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="new-terminal"]')?.classList.contains('terminal-arriving')), { label: 'terminal materialization' })
    await app.waitFor(() => app.eval(() => (window as any).__fleetboard.useApp.getState().live['new-terminal']), { label: 'shell is running before folding' })
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setStatus('new-terminal', 'needs-you'))
    await app.waitFor(() => app.eval(() => !!document.querySelector('[data-node-id="new-terminal"] .attention-beacon') && !!document.querySelector('.mm-attention')), { label: 'attention on card and minimap' })
    const originalSize = await app.eval(() => {
      const el = document.querySelector('[data-node-id="new-terminal"]') as HTMLElement
      ;(el as any).motionIdentity = 'retained'
      return [el.style.width, el.style.height]
    })
    await app.click('[data-group-id="dock-group"] button[aria-expanded="true"]')
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="new-terminal"]')!.getAnimations().length > 0), { label: 'group members fold' })
    await app.waitFor(() => app.eval(() => getComputedStyle(document.querySelector('[data-node-id="new-terminal"]')!).visibility === 'hidden'), { label: 'fold finishes and hides the terminal' })
    assert.equal(await app.eval(() => !!document.querySelector('[data-group-id="dock-group"] .attention-beacon')), true)
    await app.click('[data-group-id="dock-group"] button[aria-expanded="false"]')
    assert.deepEqual(await app.eval(() => {
      const el = document.querySelector('[data-node-id="new-terminal"]') as HTMLElement
      return [(el as any).motionIdentity, el.style.width, el.style.height]
    }), ['retained', ...originalSize], 'folding preserves terminal mount and dimensions')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const point = await app.eval(() => {
      const r = document.querySelector('[data-node-id="dock-card"] .node-head')!.getBoundingClientRect()
      return { x: r.x + 70, y: r.y + 16 }
    })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 500, y: point.y + 10, button: 'left', buttons: 1 })
    await app.waitFor(() => app.eval(() => !!document.querySelector('.dock-preview') && !!document.querySelector('[data-group-id="dock-group"].dock-target')), { label: 'magnetic docking preview' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 500, y: point.y + 10, button: 'left', buttons: 0, clickCount: 1 })
    await app.waitFor(() => app.eval(() => !document.querySelector('.dock-preview')))
    assert.equal(await app.eval(() => (window as any).__fleetboard.activeWs().nodes.find((n: any) => n.id === 'dock-card').groupId), 'dock-group')
    const again = await app.eval(() => {
      const r = document.querySelector('[data-node-id="dock-card"] .node-head')!.getBoundingClientRect()
      return { x: r.x + 70, y: r.y + 16 }
    })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...again, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: again.x + 32, y: again.y + 8, button: 'left', buttons: 1 })
    await app.waitFor(() => app.eval(() => !!document.querySelector('.dock-preview')))
    await app.eval(() => document.querySelector('[data-node-id="dock-card"] .node-head')!.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })))
    assert.equal(await app.eval(() => !!document.querySelector('.dock-preview, .dock-target')), false, 'cancelled drag cleans up previews')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: again.x + 32, y: again.y + 8, button: 'left', buttons: 0, clickCount: 1 })
    await app.eval(() => (window as any).__fleetboard.voice.useVoice.setState({ phase: 'listening', level: 0.8 }))
    await app.waitFor(() => app.eval(() => document.querySelector<HTMLElement>('.oracle-orb.listening')?.style.getPropertyValue('--audio-level') === '0.8'))
    if (process.env.E2E_SHOTS) await app.screenshot(`${process.env.E2E_SHOTS}/motion-effects.png`)
    await app.eval(() => (window as any).__fleetboard.voice.useVoice.setState({ phase: 'idle', speaking: true, outputLevel: 0.6 }))
    await app.waitFor(() => app.eval(() => document.querySelector<HTMLElement>('.oracle-orb.speaking')?.style.getPropertyValue('--audio-level') === '0.6'))
    await app.eval(() => (window as any).__fleetboard.voice.useVoice.setState({ speaking: false, phase: 'thinking' }))
    await app.waitFor(() => app.eval(() => getComputedStyle(document.querySelector('.oracle-orbit')!).animationName === 'oracle-orbit'))
    await app.eval(() => {
      const f = (window as any).__fleetboard
      f.voice.useVoice.setState({ phase: 'idle', outputLevel: null })
      f.useApp.getState().setStatus('new-terminal', 'idle')
      const p = f.useApp.getState().project
      const common = { agentId: 'shell', projectId: p.id, cwd: p.path, createdAt: Date.now() - 1000, status: 'reported' }
      f.useFleet.setState({ state: { projectId: p.id, projectPath: p.path, members: {
        'dock-card': { ...common, id: 'dock-card', name: 'Lead', role: 'lead' },
        'new-terminal': { ...common, id: 'new-terminal', name: 'Worker', role: 'worker', leadId: 'dock-card' }
      }, tasks: [], messages: [], asks: [], ready: { leadId: 'dock-card', branch: '', summary: 'Motion check complete', commits: 0, files: [], at: Date.now() } } })
    })
    await app.waitFor(() => app.eval(() => !!document.querySelector('.it-card[data-kind="ready"]')?.getAnimations().length), { label: 'Ready card completes cascade' })
    const delays = await app.eval(() => ['new-terminal', 'dock-card'].map((id) => document.querySelector(`[data-node-id="${id}"]`)!.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.getKeyframes().some((k) => 'boxShadow' in k)).map((a) => a.effect!.getTiming().delay ?? 0)))
    assert.ok(delays[0]!.includes(0) && delays[1]!.some((delay) => delay > 0), 'worker lights before lead')
    await app.eval(async () => { await (window as any).__fleetboard.useApp.getState().setSettings({ motion: 'off' }) })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'off'))
    assert.equal(await app.eval(() => document.querySelector('.it-card')!.getAnimations().length), 0, 'off cancels a running cascade')
    assert.deepEqual(app.rendererErrors, [])
  } finally { await app.close() }
})
