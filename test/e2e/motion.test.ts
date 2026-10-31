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
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.ok(await app.eval(() => {
      const el = document.querySelector('[data-node-id="motion-console"]')!
      return el.classList.contains('agent-activating') && Number(getComputedStyle(el, '::after').opacity) > 0.5
    }), 'Full activation stays clearly visible beyond the old brief flash')
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

test('workspace switching, wire preview, inbox arrival, sticky notes, zoom detail and multi-selection', async () => {
  const sb = makeSandbox()
  const app = await App.launch({ sandbox: sb })
  const cdp = (app as any).cdp
  const headPoint = (id: string) =>
    app.eval((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 14) }
    }, `[data-node-id="${id}"] .node-head`)
  try {
    await app.openProject(makeRepo(sb))
    await app.eval(async () => {
      const s = (window as any).__fleetboard.useApp.getState()
      await s.setSettings({ motion: 'full' })
      s.setCamera({ x: 0, y: 0, zoom: 1 })
      s.addNode({ id: 'polish-c', type: 'checklist', x: 80, y: 700, w: 280, h: 200, data: { items: [] } })
      s.addNode({ id: 'polish-d', type: 'checklist', x: 620, y: 700, w: 280, h: 200, data: { items: [] } })
    })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'full' && !!document.querySelector('[data-node-id="polish-d"]')))

    // Workspace switching: the incoming board settles forward, and mashing tabs cannot leave the
    // board stuck mid-animation or on the wrong workspace.
    const first = await app.eval(() => (window as any).__fleetboard.useApp.getState().project.activeWorkspaceId)
    const second = await app.eval(() => (window as any).__fleetboard.useApp.getState().addWorkspace('Second'))
    await app.waitFor(() => app.eval(() => document.querySelector('.board')!.getAnimations().length > 0), { label: 'the incoming board settles forward' })
    await app.eval((ids) => {
      const s = (window as any).__fleetboard.useApp.getState()
      for (const id of [ids[0], ids[1], ids[0], ids[1], ids[0]]) s.switchWorkspace(id!)
    }, [first, second])
    await app.waitFor(() => app.eval(() => document.querySelector('.board')!.getAnimations().length === 0), { label: 'rapid switches settle instead of queueing' })
    assert.deepEqual(
      await app.eval(() => {
        const s = (window as any).__fleetboard.useApp.getState()
        return [s.project.activeWorkspaceId, getComputedStyle(document.querySelector('.board')!).transform, document.querySelectorAll('.ws-tab.on').length, !!document.querySelector('[data-node-id="polish-c"]')]
      }),
      [first, 'none', 1, true],
      'the board is left on the workspace the last switch asked for, untransformed, with one tab lit'
    )

    // Inbox arrival: a new key is an arrival; the same list rebuilt, or cycling the front card, is not.
    const cardAnimations = () => app.eval(() => document.querySelector('.it-card')?.getAnimations().length ?? -1)
    const item = (key: string, head: string) => ({ kind: 'notice', key, who: 'Fleet', sub: 'test', since: Date.now(), actions: [], tone: 'info', head, lines: [] })
    await app.eval((one) => (window as any).__fleetboard.useInbox.setState({ items: [one], front: 'notice:1' }), item('notice:1', 'First'))
    await app.waitFor(async () => (await cardAnimations()) > 0, { label: 'a new item enters' })
    await app.waitFor(async () => ((await cardAnimations()) === 0 ? 'still' : false), { label: 'the entrance ends' })
    await app.eval((one) => (window as any).__fleetboard.useInbox.setState({ items: [one] }), item('notice:1', 'First'))
    assert.equal(await cardAnimations(), 0, 'a refresh that rebuilds the same item does not animate it')
    await app.eval((two) => {
      const f = (window as any).__fleetboard
      f.useInbox.setState({ items: [...f.useInbox.getState().items, two] })
    }, item('notice:2', 'Second'))
    assert.equal(await cardAnimations(), 0, 'an arrival behind the front card leaves the front card alone')
    await app.eval(() => (window as any).__fleetboard.useInbox.setState({ front: 'notice:2' }))
    assert.equal(await cardAnimations(), 0, 'cycling to an older card is not an arrival')
    await app.eval(() => (window as any).__fleetboard.useInbox.setState({ items: [], front: null }))

    // Wire creation: two clicks, with a preview in between that cancels every way out.
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setTool('connector'))
    const from = await headPoint('polish-c')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...from, button: 'left', buttons: 0, clickCount: 1 })
    await app.waitFor(() => app.eval(() => (window as any).__fleetboard.useApp.getState().wireFrom === 'polish-c'), { label: 'the first click arms the source' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 300, y: from.y + 60 })
    await app.waitFor(() => app.eval(() => /^M[-\d.]+,[-\d.]+ C/.test(document.querySelector('.wire-preview')?.getAttribute('d') ?? '')), { label: 'the preview curves toward the pointer' })
    assert.equal(await app.eval(() => getComputedStyle(document.querySelector('.wire-preview-layer')!).pointerEvents), 'none', 'the preview never takes a click meant for a card')
    await app.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.deepEqual(
      await app.eval(() => [(window as any).__fleetboard.useApp.getState().wireFrom, !!document.querySelector('.wire-preview')]),
      [null, false],
      'Escape disarms the connector and takes the preview with it'
    )
    await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.setTool('connector')
      s.setTool('select')
    })
    assert.equal(await app.eval(() => (window as any).__fleetboard.useApp.getState().wireFrom), null, 'changing tool drops a half-made wire')
    await app.eval(() => {
      const f = (window as any).__fleetboard
      f.useApp.getState().addNode({ id: 'polish-gone', type: 'checklist', x: 1200, y: 700, w: 240, h: 160, data: { items: [] } })
      f.useApp.getState().setTool('connector')
      f.useApp.setState({ wireFrom: 'polish-gone' })
      f.useApp.getState().removeNodes(['polish-gone'])
    })
    assert.equal(await app.eval(() => (window as any).__fleetboard.useApp.getState().wireFrom), null, 'the source being removed cancels the preview')
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setTool('connector'))
    for (const point of [await headPoint('polish-c'), await headPoint('polish-d')]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
    }
    await app.waitFor(() => app.eval(() => !!document.querySelector('.wire-draw')), { label: 'the new wire lights end to end' })
    assert.deepEqual(
      await app.eval(() => {
        const ws = (window as any).__fleetboard.activeWs()
        return [ws.wires.length, ws.wires[0].from, ws.wires[0].to, (window as any).__fleetboard.useApp.getState().tool]
      }),
      [1, 'polish-c', 'polish-d', 'select'],
      'the second click makes the wire and puts the tool back'
    )
    await app.waitFor(() => app.eval(() => !document.querySelector('.wire-draw')), { label: 'the illumination is a one-off' })
    assert.equal(await app.eval(() => document.querySelectorAll('.wire-message').length), 0, 'drawing a wire is not message traffic')

    // A sticky note unfolds when it is created, and only then.
    await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ id: 'polish-note', type: 'note', x: 1000, y: 700, w: 220, h: 200, data: { text: '', color: '#7fae5c' } }))
    await app.waitFor(() => app.eval(() => !!document.querySelector('[data-node-id="polish-note"] .note-unfold')), { label: 'a new note unfolds' })
    await app.waitFor(() => app.eval(() => !document.querySelector('.note-unfold')), { label: 'the unfold ghost removes itself' })
    await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.moveNodes(['polish-note'], 40, 20)
      s.setSelection(['polish-note'])
    })
    assert.equal(await app.eval(() => !!document.querySelector('.note-unfold')), false, 'moving or selecting an existing note does not replay its creation')

    // Zoom detail: compact labels below the threshold, with hysteresis, and never at the cost of status.
    await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.addNode({ id: 'polish-console', type: 'console', x: 80, y: 1000, w: 420, h: 240, data: { agentId: 'shell', name: 'Zoom check', cwd: s.project.path, createdAt: Date.now() } })
    })
    await app.waitFor(() => app.eval(() => !!document.querySelector('[data-node-id="polish-console"]')))
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setStatus('polish-console', 'needs-you'))
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setCamera({ zoom: 0.4 }))
    await app.waitFor(() => app.eval(() => document.querySelector('.board')!.classList.contains('zoom-compact')), { label: 'cards drop to compact labels' })
    assert.ok(
      await app.eval(() => {
        const beacon = document.querySelector('[data-node-id="polish-console"] .attention-beacon') as HTMLElement | null
        const title = document.querySelector('[data-node-id="polish-console"] .node-title') as HTMLElement | null
        return !!beacon && getComputedStyle(beacon).visibility !== 'hidden' && !!title && parseFloat(getComputedStyle(title).fontSize) > 20
      }),
      'compact keeps the needs-you beacon and gives the label a readable size'
    )
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setCamera({ zoom: 0.55 }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await app.eval(() => document.querySelector('.board')!.classList.contains('zoom-compact')), true, 'inside the hysteresis gap the layout holds still')
    if (process.env.E2E_SHOTS) await app.screenshot(`${process.env.E2E_SHOTS}/motion-polish-compact.png`)
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setCamera({ zoom: 1 }))
    await app.waitFor(() => app.eval(() => !document.querySelector('.board.zoom-compact')), { label: 'detail comes back' })
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setStatus('polish-console', 'idle'))

    // Multi-selection: one shared boundary, in board coordinates, that takes no clicks.
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setSelection(['polish-c']))
    assert.equal(await app.eval(() => !!document.querySelector('.sel-bounds')), false, 'a single item needs no shared boundary')
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setSelection(['polish-c', 'polish-d']))
    await app.waitFor(() => app.eval(() => !!document.querySelector('.world > .sel-bounds')), { label: 'the boundary is drawn inside the world, so it pans and zooms with the items' })
    await app.waitFor(() => app.eval(() => document.querySelector('[data-node-id="polish-d"]')!.getAnimations().length > 0), { label: 'the frames joining the selection are acknowledged' })
    assert.deepEqual(
      await app.eval(() => {
        const el = document.querySelector('.sel-bounds') as HTMLElement
        return [el.style.left, el.style.top, el.style.width, getComputedStyle(el).pointerEvents]
      }),
      ['80px', '700px', '820px', 'none'],
      'the boundary covers both cards and ignores the pointer'
    )
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setSelection(['polish-c']))
    assert.equal(await app.eval(() => !!document.querySelector('.sel-bounds')), false, 'the boundary goes the moment the selection does')
    // Both levels, side by side, for the eyes that have to sign the effects off.
    if (process.env.E2E_SHOTS) {
      for (const level of ['full', 'subtle'] as const) {
        await app.eval(async (motion) => {
          const s = (window as any).__fleetboard.useApp.getState()
          await s.setSettings({ motion })
          s.setSelection(['polish-c', 'polish-d'])
          s.setTool('connector')
          ;(window as any).__fleetboard.useApp.setState({ wireFrom: 'polish-c' })
          s.addNode({ type: 'note', x: 1000, y: 1000, w: 220, h: 200, data: { text: '', color: '#d4a72c' } })
        }, level)
        await new Promise((resolve) => setTimeout(resolve, 120))
        await app.screenshot(`${process.env.E2E_SHOTS}/motion-polish-${level}.png`)
      }
      await app.eval(async () => {
        const s = (window as any).__fleetboard.useApp.getState()
        s.setTool('select')
        await s.setSettings({ motion: 'full' })
      })
    }

    // Off: nothing keeps moving, and every final state is still there and usable.
    await app.eval(() => (window as any).__fleetboard.useApp.getState().setSelection(['polish-c', 'polish-d']))
    await app.eval(async () => { await (window as any).__fleetboard.useApp.getState().setSettings({ motion: 'off' }) })
    await app.waitFor(() => app.eval(() => document.documentElement.dataset.motion === 'off'))
    await app.eval(() => {
      const s = (window as any).__fleetboard.useApp.getState()
      s.addNode({ id: 'polish-note-off', type: 'note', x: 1400, y: 700, w: 220, h: 200, data: { text: '', color: '#5f97c9' } })
      s.addWire('polish-c', 'polish-console')
    })
    await app.waitFor(() => app.eval(() => !!document.querySelector('[data-node-id="polish-note-off"]')))
    assert.deepEqual(
      await app.eval(() => [
        [...document.querySelectorAll('.board, .board *')].reduce((n, el) => n + el.getAnimations().length, 0),
        !!document.querySelector('.note-unfold'),
        !!document.querySelector('.wire-draw'),
        !!document.querySelector('.sel-bounds'),
        (window as any).__fleetboard.activeWs().wires.length
      ]),
      [0, false, false, true, 2],
      'off leaves nothing running, while the wire and the shared boundary are there as final states'
    )
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})
