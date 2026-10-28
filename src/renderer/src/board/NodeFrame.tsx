import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import type { BoardNode } from '@shared/types'
import { mayRemove } from './removeHooks'
import { NODE_DEFS } from '../nodes/registry'
import { activeWs, connectClick, focusRect, useApp } from '../state/store'
import { groupAt, snap } from './geometry'
import { Boundary } from '../ui/Boundary'
import { createAsciiReveal } from 'ascii-reveal'
import { boardIsRevealed } from '../lib/reveal'
import { currentMotion, useMotion } from '../ui/motion'
import { motionDuration } from '@shared/motion'
import { AttentionBeacon } from '../ui/AttentionBeacon'
import { dockingPreview } from './docking'

/**
 * Begin a drag that moves the node (and the rest of the selection) with the pointer.
 * With onClick, nothing moves until the pointer travels a few pixels, and a press that never does
 * counts as a click instead (used by click-to-zoom on a tile's body).
 */
export function startNodeDrag(e: React.PointerEvent, node: BoardNode, onClick?: () => void) {
  if (e.button !== 0) return
  e.stopPropagation()
  const app = useApp.getState()
  const ids = app.selection.includes(node.id) ? app.selection : [node.id]
  if (!app.selection.includes(node.id)) app.setSelection(e.shiftKey ? [...app.selection, node.id] : [node.id])
  app.bringToFront(node.id)
  const zoom = activeWs()!.camera.zoom
  let lastX = e.clientX
  let lastY = e.clientY
  let moved = 0
  const sx = e.clientX
  const sy = e.clientY
  let dragging = !onClick
  const el = e.currentTarget as HTMLElement
  const preview = dockingPreview()
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return
      dragging = true
      lastX = sx
      lastY = sy
    }
    const dx = (ev.clientX - lastX) / zoom
    const dy = (ev.clientY - lastY) / zoom
    lastX = ev.clientX
    lastY = ev.clientY
    moved += Math.abs(dx) + Math.abs(dy)
    useApp.getState().moveNodes(ids, dx, dy)
    const ws = activeWs()
    const current = ws?.nodes.find((n) => n.id === node.id)
    if (ws && current) preview.update(current, ws.groups)
  }
  const cleanup = () => {
    preview.clear()
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', cleanup)
    el.removeEventListener('lostpointercapture', cleanup)
    window.removeEventListener('blur', cleanup)
  }
  const up = () => {
    cleanup()
    if (!dragging) return onClick?.()
    if (moved < 2) return
    // snap and update group membership by where each node was dropped
    const ws = activeWs()!
    for (const id of ids) {
      const n = ws.nodes.find((x) => x.id === id)
      if (!n) continue
      const g = groupAt(ws.groups, n.x + n.w / 2, n.y + 20)
      const patch: Partial<BoardNode> = { x: snap(n.x), y: snap(n.y) }
      if ((g?.id ?? undefined) !== n.groupId) patch.groupId = g?.id
      useApp.getState().updateNode(id, patch)
      if (g && g.id !== n.groupId) useApp.getState().fitGroup(g.id)
    }
    preview.settle(ids)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', cleanup)
  el.addEventListener('lostpointercapture', cleanup)
  window.addEventListener('blur', cleanup, { once: true })
}

function startResize(e: React.PointerEvent, node: BoardNode, edge: 'r' | 'b' | 'rb') {
  e.stopPropagation()
  e.preventDefault()
  const def = NODE_DEFS[node.type]
  const zoom = activeWs()!.camera.zoom
  const sx = e.clientX
  const sy = e.clientY
  const { w, h } = node
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const patch: Partial<BoardNode> = {}
    if (edge !== 'b') patch.w = Math.max(def.minSize.w, snap(w + (ev.clientX - sx) / zoom))
    if (edge !== 'r') patch.h = Math.max(def.minSize.h, snap(h + (ev.clientY - sy) / zoom))
    useApp.getState().updateNode(node.id, patch)
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    if (node.groupId) useApp.getState().fitGroup(node.groupId)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

export async function removeWithHooks(ids: string[]) {
  const ws = activeWs()
  if (!ws) return
  if (!(await mayRemove(ws.nodes.filter((n) => ids.includes(n.id))))) return
  useApp.getState().removeNodes(ids)
  useApp.getState().setSelection([])
}

interface FrameProps {
  node: BoardNode
  selected: boolean
  zoom: number
  maximized?: boolean
  /** in a collapsed group: kept mounted at its size, so its terminal keeps running unresized, but not shown */
  hidden?: boolean
  offscreen?: boolean
}

// Tiles that zoom in on a click to their body. Sticky notes and text labels edit in place instead.
const NO_CLICK_ZOOM = new Set(['note', 'text'])

function UnknownNode({ node, selected }: { node: BoardNode; selected: boolean }) {
  return (
    <div
      className={`node node-unknown ${selected ? 'selected' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, zIndex: node.z }}
      onPointerDown={(e) => startNodeDrag(e, node)}
    >
      <div className="node-unknown-body">
        <div className="label">Unknown tile</div>
        <div className="muted small">
          This board has a <code className="mono">{node.type}</code> tile, which this version of Fleetboard does not know how to draw. Updating may bring
          it back.
        </div>
        <button className="btn sm" onClick={() => useApp.getState().removeNodes([node.id])}>
          Remove it
        </button>
      </div>
    </div>
  )
}

export const NodeFrame = memo(function NodeFrame({ node, selected, zoom, maximized = false, hidden = false, offscreen = false }: FrameProps) {
  const def = NODE_DEFS[node.type]
  const ref = useRef<HTMLDivElement>(null)
  const viewport = useApp((s) => s.viewport)
  const working = useApp((s) => node.type === 'console' && s.statuses[node.id] === 'working')
  const needs = useApp((s) => node.type === 'console' && s.statuses[node.id] === 'needs-you')
  const motion = useMotion()
  const allowReveal = motion !== 'off'
  const revealed = useRef(false)
  const wasWorking = useRef(working)
  const wasHidden = useRef(hidden)
  useLayoutEffect(() => {
    const changed = wasHidden.current !== hidden
    wasHidden.current = hidden
    if (!changed || motion === 'off' || !ref.current) return
    const frames = [
      { opacity: 0, transform: 'translateY(-8px) scale(0.98)', visibility: 'visible' },
      { opacity: 1, transform: 'translateY(0) scale(1)', visibility: 'visible' }
    ]
    const animation = ref.current.animate(hidden ? frames.reverse() : frames, { duration: motionDuration(motion), easing: 'ease-out' })
    return () => animation.cancel()
  }, [hidden, motion])
  useEffect(() => {
    const started = working && !wasWorking.current
    wasWorking.current = working
    const el = ref.current
    if (!started || motion === 'off' || hidden || offscreen || !el) return
    el.classList.remove('agent-activating')
    void el.offsetWidth
    el.classList.add('agent-activating')
    const timer = window.setTimeout(() => el.classList.remove('agent-activating'), 900)
    return () => { clearTimeout(timer); el.classList.remove('agent-activating') }
  }, [working, motion, hidden, offscreen])

  // A tile that arrives after its board's wave decodes itself in. A console's terminal body carries
  // data-ascii="skip", so live output is never redrawn through the glyph grid.
  // Attached imperatively because the root's ref is already taken.
  useEffect(() => {
    if (!allowReveal || currentMotion() === 'off' || revealed.current || !boardIsRevealed(activeWs()?.id) || !ref.current) return
    revealed.current = true
    if (node.type === 'console') {
      const el = ref.current
      if (hidden || offscreen) return
      el.classList.add('terminal-arriving')
      const animation = el.animate([{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'scale(1)' }], { duration: currentMotion() === 'full' ? 280 : 180, easing: 'ease-out' })
      const timer = window.setTimeout(() => el.classList.remove('terminal-arriving'), 500)
      return () => { animation.cancel(); clearTimeout(timer); el.classList.remove('terminal-arriving') }
    }
    let live = true
    const r = createAsciiReveal(ref.current, { preset: 'terminal' })
    void r.reveal().finally(() => {
      if (live) r.destroy()
    })
    return () => {
      live = false
      r.destroy()
    }
  }, [allowReveal, node.type, hidden, offscreen])
  const tool = useApp((s) => s.tool)
  // A type this build does not know — a board written by a newer Fleetboard, or edited by hand. It
  // used to render nothing at all: the tile was invisible, unselectable and undeletable, while still
  // taking up its place in the file. Better to show that something is there and let it be removed.
  if (!def) return <UnknownNode node={node} selected={selected} />
  const Body = def.component
  const Header = def.header
  const Actions = def.actions
  const Icon = def.icon
  const focused = maximized
  const props = { node, selected, zoom, maximized }
  const app = () => useApp.getState()
  const toggleFocus = () => (focused ? app().exitFocus() : app().enterFocus(node.id))
  const fr = focused ? focusRect(viewport) : null
  // zoomed out, a click on the body dives in; close up (>= 90%) clicks go straight to the content
  const catcher = !focused && tool === 'select' && zoom < 0.9 && !NO_CLICK_ZOOM.has(node.type)

  return (
    <div
      ref={ref}
      className={`node node-${node.type} ${selected && !focused ? 'selected' : ''} ${def.chromeless ? 'chromeless' : ''} ${focused ? 'focused' : ''} ${hidden ? 'in-collapsed' : ''}`}
      aria-hidden={hidden || undefined}
      style={{ contentVisibility: offscreen && !focused ? 'hidden' : undefined, left: node.x, top: node.y, width: fr ? fr.w : node.w, height: fr ? fr.h : node.h, zIndex: focused ? 100000 : node.z }}
      data-node-id={node.id}
      data-working={working || undefined}
      onPointerDown={(e) => {
        if (focused) return e.stopPropagation()
        const a = app()
        if (a.tool === 'connector') {
          e.stopPropagation()
          return connectClick(node.id)
        }
        if (!a.selection.includes(node.id)) a.setSelection(e.shiftKey ? [...a.selection, node.id] : [node.id])
        a.bringToFront(node.id)
        e.stopPropagation()
      }}
    >
      {node.type === 'console' && <span className="terminal-corners" aria-hidden="true" />}
      {needs && <AttentionBeacon />}
      {!def.chromeless && (
        <div
          className="node-head"
          onPointerDown={(e) => !focused && app().tool !== 'connector' && startNodeDrag(e, node)}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button,input')) return
            toggleFocus()
          }}
        >
          {Header ? (
            <Boundary what={def.label} compact resetKey={node.data}>
              <Header {...props} />
            </Boundary>
          ) : (
            <div className="row grow" style={{ gap: 7, minWidth: 0 }}>
              <Icon size={13} className="node-icon" />
              <span className="node-title">{node.title ?? def.label}</span>
              <span className="spacer" />
            </div>
          )}
          <div className="node-actions" onPointerDown={(e) => e.stopPropagation()}>
            {Actions && (
              <Boundary what="Actions" compact resetKey={node.data}>
                <Actions {...props} />
              </Boundary>
            )}
            <button className="icon-btn sm" title={focused ? 'Back to board (Ctrl+Shift+F)' : 'Focus (click the tile, F or Ctrl+Shift+F)'} onClick={toggleFocus}>
              {focused ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button className="icon-btn sm" title="Close" onClick={() => removeWithHooks([node.id])}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="node-body">
        <Boundary what={`This ${def.label.toLowerCase()}`} resetKey={node.data} actions={[{ label: 'Remove tile', run: () => removeWithHooks([node.id]), danger: true }]}>
          <Body {...props} />
        </Boundary>
        {catcher && (
          <div
            className="zoom-catcher"
            title="Click to focus"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              const a = app()
              if (e.shiftKey || e.ctrlKey || e.metaKey) {
                // select without zooming (toggle)
                a.setSelection(a.selection.includes(node.id) ? a.selection.filter((x) => x !== node.id) : [...a.selection, node.id])
                return
              }
              startNodeDrag(e, node, () => app().enterFocus(node.id))
            }}
          />
        )}
      </div>
      {!focused && (
        <>
          <div className="rz rz-r" onPointerDown={(e) => startResize(e, node, 'r')} />
          <div className="rz rz-b" onPointerDown={(e) => startResize(e, node, 'b')} />
          <div className="rz rz-rb" onPointerDown={(e) => startResize(e, node, 'rb')} />
        </>
      )}
    </div>
  )
}, (a, b) => {
  if (a.node !== b.node || a.selected !== b.selected || a.maximized !== b.maximized || a.hidden !== b.hidden || a.offscreen !== b.offscreen) return false
  // Terminal bodies, headers and actions do not use camera scale. Only their click catcher changes
  // at 90%, so camera animation need not rerender every terminal on every frame.
  return a.node.type === 'console' ? (a.zoom < 0.9) === (b.zoom < 0.9) : a.zoom === b.zoom
})
