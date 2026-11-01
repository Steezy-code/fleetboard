import { useEffect, useRef, type RefObject } from 'react'
import type { Workspace } from '@shared/types'
import { edgePoint, type Rect } from './geometry'
import { groupBox } from './place'
import { screenToWorld, useApp } from '../state/store'

type WireSpace = Pick<Workspace, 'nodes' | 'groups'>

/**
 * The connector is a two-click tool: this is the line waiting for the second click.
 *
 * Drawn inside `.world`, so the camera transform carries it, and updated by writing the path
 * attribute straight from the pointer handler — a board-wide rerender per pointer frame would cost
 * far more than the line is worth. It is an affordance rather than decoration, so it is drawn at
 * every motion level; what Off takes away is the dash that marches along it.
 */
export function WirePreview({ ws, boardRef }: { ws: WireSpace; boardRef: RefObject<HTMLDivElement | null> }) {
  const wireFrom = useApp((s) => s.wireFrom)
  const tool = useApp((s) => s.tool)
  const armed = tool === 'connector' ? wireFrom : null
  const ref = useRef<SVGPathElement>(null)
  const node = armed ? ws.nodes.find((n) => n.id === armed) : undefined
  const group = armed && !node ? ws.groups.find((g) => g.id === armed) : undefined
  const source: Rect | undefined = node ?? (group ? groupBox(group) : undefined)
  const sx = source?.x
  const sy = source?.y

  useEffect(() => {
    if (!armed || !source) return
    const from = { x: source.x, y: source.y, w: source.w, h: source.h }
    const move = (e: PointerEvent) => {
      const rect = boardRef.current?.getBoundingClientRect()
      const path = ref.current
      if (!rect || !path) return
      const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      const a = edgePoint(from, p)
      const dx = (p.x - a.x) * 0.45
      path.setAttribute('d', `M${a.x},${a.y} C${a.x + dx},${a.y} ${p.x - dx},${p.y} ${p.x},${p.y}`)
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
    // the rect is read through its own fields: a node object is new on every board save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, sx, sy, source?.w, source?.h, boardRef])

  if (!armed || !source) return null
  // starts at the source's own edge, so an armed tool reads as armed before the pointer moves
  const start = edgePoint(source, { x: source.x + source.w / 2 + 1, y: source.y + source.h / 2 })
  return (
    <svg className="wires wire-preview-layer" width="1" height="1" aria-hidden="true">
      <path ref={ref} className="wire-preview" d={`M${start.x},${start.y} L${start.x},${start.y}`} />
    </svg>
  )
}
