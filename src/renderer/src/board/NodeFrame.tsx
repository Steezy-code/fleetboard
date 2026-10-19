import { memo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, X } from 'lucide-react'
import type { BoardNode } from '@shared/types'
import { NODE_DEFS } from '../nodes/registry'
import { activeWs, connectClick, useApp } from '../state/store'
import { groupAt, snap } from './geometry'

/** Begin a drag that moves the node (and the rest of the selection) with the pointer. */
export function startNodeDrag(e: React.PointerEvent, node: BoardNode) {
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
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - lastX) / zoom
    const dy = (ev.clientY - lastY) / zoom
    lastX = ev.clientX
    lastY = ev.clientY
    moved += Math.abs(dx) + Math.abs(dy)
    useApp.getState().moveNodes(ids, dx, dy)
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
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
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
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
  const nodes = ws.nodes.filter((n) => ids.includes(n.id))
  const byType = new Map<string, BoardNode[]>()
  for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n])
  for (const [type, list] of byType) {
    const hook = NODE_DEFS[type as BoardNode['type']]?.beforeRemove
    if (hook && !(await hook(list))) return
  }
  useApp.getState().removeNodes(ids)
  useApp.getState().setSelection([])
}

interface FrameProps {
  node: BoardNode
  selected: boolean
  zoom: number
  maximized?: boolean
}

export const NodeFrame = memo(function NodeFrame({ node, selected, zoom, maximized = false }: FrameProps) {
  const def = NODE_DEFS[node.type]
  const ref = useRef<HTMLDivElement>(null)
  if (!def) return null
  const Body = def.component
  const Header = def.header
  const Actions = def.actions
  const Icon = def.icon
  const props = { node, selected, zoom, maximized }
  const setFocused = useApp.getState().setFocusedNode

  const frame = (
    <div
      ref={ref}
      className={`node node-${node.type} ${selected ? 'selected' : ''} ${def.chromeless ? 'chromeless' : ''} ${maximized ? 'maximized' : ''}`}
      style={maximized ? undefined : { left: node.x, top: node.y, width: node.w, height: node.h, zIndex: node.z }}
      data-node-id={node.id}
      onPointerDown={(e) => {
        if (maximized) return
        const app = useApp.getState()
        if (app.tool === 'connector') {
          e.stopPropagation()
          return connectClick(node.id)
        }
        if (!app.selection.includes(node.id)) app.setSelection(e.shiftKey ? [...app.selection, node.id] : [node.id])
        app.bringToFront(node.id)
        e.stopPropagation()
      }}
    >
      {!def.chromeless && (
        <div
          className="node-head"
          onPointerDown={(e) => !maximized && useApp.getState().tool !== 'connector' && startNodeDrag(e, node)}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button,input')) return
            setFocused(maximized ? null : node.id)
          }}
        >
          {Header ? (
            <Header {...props} />
          ) : (
            <div className="row grow" style={{ gap: 7, minWidth: 0 }}>
              <Icon size={13} className="node-icon" />
              <span className="node-title">{node.title ?? def.label}</span>
              <span className="spacer" />
            </div>
          )}
          <div className="node-actions" onPointerDown={(e) => e.stopPropagation()}>
            {Actions && <Actions {...props} />}
            <button className="icon-btn sm" title={maximized ? 'Restore' : 'Maximize'} onClick={() => setFocused(maximized ? null : node.id)}>
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              className="icon-btn sm"
              title="Close"
              onClick={() => {
                if (maximized) setFocused(null)
                removeWithHooks([node.id])
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="node-body">
        <Body {...props} />
      </div>
      {!maximized && (
        <>
          <div className="rz rz-r" onPointerDown={(e) => startResize(e, node, 'r')} />
          <div className="rz rz-b" onPointerDown={(e) => startResize(e, node, 'b')} />
          <div className="rz rz-rb" onPointerDown={(e) => startResize(e, node, 'rb')} />
        </>
      )}
    </div>
  )
  if (maximized) {
    return createPortal(
      <div className="maximized-scrim" onPointerDown={(e) => e.target === e.currentTarget && setFocused(null)}>
        {frame}
      </div>,
      document.body
    )
  }
  return frame
})
