import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { InkItem, Workspace } from '@shared/types'
import { uid } from '../lib/api'
import { screenToWorld, useApp } from '../state/store'
import { InkShape, hasFill, linePath, outlinePath } from './ink/InkShape'
import { bboxOfPoints, hitTest, isClosedShape, itemBox, labelSize, linePoints, textBox, unionBox, type Box } from './ink/geometry'
import { patchInk, useInkUi } from './ink/inkState'
import { InkTextEditor } from './ink/InkTextEditor'
import type { Pt } from './ink/rough'

// Freehand ink, shapes and labels drawn on the board. Rendered in screen space above the nodes (so it
// can mark up images) with the camera applied as an SVG transform. The SVG itself ignores the pointer;
// in select mode each item gets an invisible hit path so it can be clicked, dragged and edited.

export { inkPath } from './ink/geometry'
export { InkShape }

const snapAngle = (from: Pt, to: Pt): Pt => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const len = Math.hypot(dx, dy)
  const step = Math.PI / 12
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len]
}

export const InkLayer = memo(function InkLayer({ ws }: { ws: Workspace }) {
  const tool = useApp((s) => s.tool)
  const shapeKind = useApp((s) => s.shapeKind)
  const selection = useApp((s) => s.selection)
  const editing = useInkUi((s) => s.editing)
  const [draft, setDraft] = useState<InkItem | null>(null)
  const draftRef = useRef<InkItem | null>(null)
  const drawing = useRef<{ start: Pt; last: Pt } | null>(null)
  const cam = ws.camera
  const zoom = cam.zoom
  const capture = tool === 'pen' || tool === 'eraser' || tool === 'shape'
  const hitMode = tool === 'select'

  const setD = (d: InkItem | null) => {
    draftRef.current = d
    setDraft(d)
  }

  // switching tools mid-stroke drops the unfinished draft
  useEffect(() => {
    drawing.current = null
    setD(null)
  }, [tool])

  // Leaving the board / workspace stops editing.
  useEffect(() => () => useInkUi.setState({ editing: null }), [ws.id])

  const selInk = useMemo(() => {
    const s = new Set(selection)
    return ws.ink.filter((i) => s.has(i.id))
  }, [ws.ink, selection])
  const onlyInk = selInk.length > 0 && selInk.length === selection.length

  // ---------- drawing tools ----------
  const erase = (from: Pt, to: Pt) => {
    const tol = 7 / zoom
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (4 / zoom)))
    const hit = new Set<string>()
    const ink = ws.ink
    for (let k = 0; k <= steps; k++) {
      const x = from[0] + ((to[0] - from[0]) * k) / steps
      const y = from[1] + ((to[1] - from[1]) * k) / steps
      const h = hitTest(ink.filter((i) => !hit.has(i.id)), x, y, tol)
      if (h) hit.add(h.id)
    }
    if (hit.size) useApp.getState().removeInk([...hit])
  }

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const w = screenToWorld(e.clientX, e.clientY)
    const p: Pt = [w.x, w.y]
    const style = useApp.getState().inkStyle
    drawing.current = { start: p, last: p }
    if (tool === 'eraser') return erase(p, p)
    const base = {
      id: uid('ink'),
      x: p[0],
      y: p[1],
      w: 0,
      h: 0,
      stroke: style.stroke,
      width: style.width,
      opacity: style.opacity
    }
    if (tool === 'pen') return setD({ ...base, kind: 'path', points: [p] })
    // shape tool
    if (shapeKind === 'label') {
      drawing.current = null
      const fontSize = style.width <= 2 ? 16 : style.width >= 5 ? 28 : 20
      const id = base.id
      useApp.getState().addInk([{ ...base, kind: 'label', y: p[1] - fontSize * 0.65, text: '', fontSize, sloppy: style.sloppy }])
      useApp.setState({ tool: 'select', selection: [id] })
      useInkUi.setState({ editing: id })
      return
    }
    const kind = shapeKind === 'path' ? 'rect' : shapeKind
    const shape: InkItem = {
      ...base,
      kind,
      fill: kind === 'line' || kind === 'arrow' ? undefined : style.fill,
      dashed: style.dashed,
      sloppy: style.sloppy,
      rounded: style.rounded
    }
    if (kind === 'line' || kind === 'arrow') shape.points = [p, p]
    setD(shape)
  }

  const move = (e: React.PointerEvent) => {
    const st = drawing.current
    if (!st) return
    const w = screenToWorld(e.clientX, e.clientY)
    let p: Pt = [w.x, w.y]
    if (tool === 'eraser') {
      erase(st.last, p)
      st.last = p
      return
    }
    const d = draftRef.current
    if (!d) return
    if (d.kind === 'path') {
      const last = d.points![d.points!.length - 1]
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.4 / zoom) return
      setD({ ...d, points: [...d.points!, p] })
    } else if (d.kind === 'line' || d.kind === 'arrow') {
      if (e.shiftKey) p = snapAngle(st.start, p)
      const pts: Pt[] = [st.start, p]
      setD({ ...d, points: pts, ...bboxOfPoints(pts) })
    } else {
      let dx = p[0] - st.start[0]
      let dy = p[1] - st.start[1]
      if (e.shiftKey) {
        const m = Math.max(Math.abs(dx), Math.abs(dy))
        dx = Math.sign(dx || 1) * m
        dy = Math.sign(dy || 1) * m
      }
      if (e.altKey) {
        setD({ ...d, x: st.start[0] - Math.abs(dx), y: st.start[1] - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 })
      } else {
        setD({ ...d, x: Math.min(st.start[0], st.start[0] + dx), y: Math.min(st.start[1], st.start[1] + dy), w: Math.abs(dx), h: Math.abs(dy) })
      }
    }
    st.last = p
  }

  const up = () => {
    drawing.current = null
    const d = draftRef.current
    setD(null)
    if (!d) return
    const app = useApp.getState()
    if (d.kind === 'path') {
      let pts = d.points ?? []
      if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.01, pts[0][1]]]
      app.addInk([{ ...d, points: pts, ...bboxOfPoints(pts) }])
      return
    }
    const b = itemBox(d)
    if (Math.max(b.w, b.h) * zoom < 4) return
    app.addInk([d])
    useApp.setState({ tool: 'select', selection: [d.id] })
  }

  // ---------- select / drag / edit ----------
  const onHitDown = (e: React.PointerEvent, item: InkItem) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const app = useApp.getState()
    const group = item.figureId && !e.altKey ? ws.ink.filter((i) => i.figureId === item.figureId).map((i) => i.id) : [item.id]
    let sel = app.selection
    if (e.shiftKey) {
      sel = group.every((id) => sel.includes(id)) ? sel.filter((id) => !group.includes(id)) : [...new Set([...sel, ...group])]
    } else if (!sel.includes(item.id)) sel = group
    app.setSelection(sel)
    if (!sel.includes(item.id)) return
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    let lx = e.clientX
    let ly = e.clientY
    let moved = false
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - lx) / zoom
      const dy = (ev.clientY - ly) / zoom
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return
      moved = true
      lx = ev.clientX
      ly = ev.clientY
      useApp.getState().moveNodes(sel, dx, dy)
    }
    const end = () => {
      el.removeEventListener('pointermove', mv as any)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
    el.addEventListener('pointermove', mv as any)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  const onHitDouble = (e: React.MouseEvent, item: InkItem) => {
    e.stopPropagation()
    if (item.kind === 'path') return
    useApp.getState().setSelection([item.id])
    useInkUi.setState({ editing: item.id })
  }

  /** Corner handle: scale the selected ink around the top-left of its bounds. */
  const onResizeDown = (e: React.PointerEvent, box: Box) => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    const orig = selInk.map((i) => ({ ...i }))
    const lockAspect = orig.length === 1 && orig[0].kind === 'label'
    const sx0 = e.clientX
    const sy0 = e.clientY
    const mv = (ev: PointerEvent) => {
      let sx = Math.max(8, box.w + (ev.clientX - sx0) / zoom) / (box.w || 1)
      let sy = Math.max(8, box.h + (ev.clientY - sy0) / zoom) / (box.h || 1)
      if (lockAspect || ev.shiftKey) sx = sy = Math.max(sx, sy)
      const patches: Record<string, Partial<InkItem>> = {}
      for (const i of orig) {
        const p: Partial<InkItem> = {
          x: box.x + (i.x - box.x) * sx,
          y: box.y + (i.y - box.y) * sy,
          w: i.w * sx,
          h: i.h * sy
        }
        if (i.points) p.points = i.points.map(([x, y]) => [box.x + (x - box.x) * sx, box.y + (y - box.y) * sy] as [number, number])
        if (i.kind === 'label') {
          const s = labelSize(i)
          p.w = s.w * sx
          p.h = s.h * sy
          p.fontSize = Math.max(6, (i.fontSize ?? 20) * sy)
        }
        patches[i.id] = p
      }
      patchInk(patches, false)
    }
    const end = () => {
      el.removeEventListener('pointermove', mv as any)
      el.removeEventListener('pointerup', end)
      if (orig[0]) useApp.getState().updateInk(orig[0].id, {})
    }
    el.addEventListener('pointermove', mv as any)
    el.addEventListener('pointerup', end)
  }

  /** Endpoint handles of a single selected line/arrow. */
  const onPointDown = (e: React.PointerEvent, item: InkItem, idx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    const pts0 = linePoints(item).map((p) => [...p] as Pt)
    const mv = (ev: PointerEvent) => {
      const w = screenToWorld(ev.clientX, ev.clientY)
      let p: Pt = [w.x, w.y]
      const anchor = pts0[idx === 0 ? 1 : idx - 1]
      if (ev.shiftKey && anchor) p = snapAngle(anchor, p)
      const pts = pts0.map((q, k) => (k === idx ? p : q))
      patchInk({ [item.id]: { points: pts, ...bboxOfPoints(pts) } }, false)
    }
    const end = () => {
      el.removeEventListener('pointermove', mv as any)
      el.removeEventListener('pointerup', end)
      useApp.getState().updateInk(item.id, {})
    }
    el.addEventListener('pointermove', mv as any)
    el.addEventListener('pointerup', end)
  }

  const union = onlyInk ? unionBox(selInk.map(itemBox)) : null
  const pad = 6 / zoom
  const singleLine = selInk.length === 1 && onlyInk && (selInk[0].kind === 'line' || selInk[0].kind === 'arrow') ? selInk[0] : null
  const editItem = editing ? ws.ink.find((i) => i.id === editing) : undefined

  return (
    <>
      <svg className={`ink ${hitMode ? 'ink-select' : ''}`}>
        <g transform={`translate(${cam.x},${cam.y}) scale(${zoom})`}>
          {ws.ink.map((i) => (
            <InkShape key={i.id} item={i} hideText={i.id === editing} />
          ))}
          {draft && <InkShape item={draft} />}

          {selInk.map((i) => {
            const b = itemBox(i)
            return (
              <rect
                key={'sel' + i.id}
                className={`ink-sel ${selInk.length > 1 ? 'faint' : ''}`}
                x={b.x - pad}
                y={b.y - pad}
                width={b.w + pad * 2}
                height={b.h + pad * 2}
                rx={4 / zoom}
              />
            )
          })}
          {union && selInk.length > 1 && (
            <rect className="ink-sel" x={union.x - pad * 2} y={union.y - pad * 2} width={union.w + pad * 4} height={union.h + pad * 4} rx={5 / zoom} />
          )}

          {hitMode &&
            ws.ink.map((i) => (i.id === editing ? null : <InkHit key={'hit' + i.id} item={i} zoom={zoom} onDown={onHitDown} onDouble={onHitDouble} />))}

          {hitMode && union && !singleLine && !editing && (
            <rect
              className="ink-handle"
              x={union.x + union.w + pad * (selInk.length > 1 ? 2 : 1) - 5 / zoom}
              y={union.y + union.h + pad * (selInk.length > 1 ? 2 : 1) - 5 / zoom}
              width={10 / zoom}
              height={10 / zoom}
              rx={2.5 / zoom}
              onPointerDown={(e) => onResizeDown(e, union)}
            />
          )}
          {hitMode &&
            singleLine &&
            !editing &&
            linePoints(singleLine).map((p, k) => (
              <circle key={k} className="ink-handle round" cx={p[0]} cy={p[1]} r={5.5 / zoom} onPointerDown={(e) => onPointDown(e, singleLine, k)} />
            ))}
        </g>
      </svg>
      {capture && <div className={`ink-capture ${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />}
      {editItem && <InkTextEditor key={editItem.id} item={editItem} cam={cam} />}
    </>
  )
})

/** Invisible, generous hit geometry for one item (select mode only). */
const InkHit = memo(function InkHit({
  item,
  zoom,
  onDown,
  onDouble
}: {
  item: InkItem
  zoom: number
  onDown: (e: React.PointerEvent, i: InkItem) => void
  onDouble: (e: React.MouseEvent, i: InkItem) => void
}) {
  const tol = Math.max(10 / zoom, item.width + 6 / zoom)
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => onDown(e, item),
    onDoubleClick: (e: React.MouseEvent) => onDouble(e, item)
  }
  if (item.kind === 'label') {
    const s = labelSize(item)
    return <rect className="ink-hit" x={item.x - 3} y={item.y - 3} width={s.w + 6} height={s.h + 6} fill="transparent" pointerEvents="all" {...handlers} />
  }
  if (isClosedShape(item.kind)) {
    const solid = hasFill(item) || !!item.text
    return (
      <path
        className="ink-hit"
        d={outlinePath(item)}
        fill="transparent"
        stroke="transparent"
        strokeWidth={tol}
        pointerEvents={solid ? 'all' : 'stroke'}
        {...handlers}
      />
    )
  }
  const tb = item.text && item.kind !== 'path' ? textBox(item) : null
  return (
    <>
      <path className="ink-hit" d={linePath(item)} fill="none" stroke="transparent" strokeWidth={tol} strokeLinecap="round" pointerEvents="stroke" {...handlers} />
      {tb && <rect className="ink-hit" x={tb.x + tb.w / 2 - 50} y={tb.y + tb.h / 2 - 14} width={100} height={28} fill="transparent" pointerEvents="all" {...handlers} />}
    </>
  )
})
