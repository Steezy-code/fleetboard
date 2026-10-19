import { memo } from 'react'
import type { Workspace } from '@shared/types'
import { center, edgePoint, type Rect } from './geometry'
import { useApp } from '../state/store'
import { useFleet } from '../engine/fleet'

/** Curved orchestrator wires between board items, with a dot travelling along each. */
export const Wires = memo(function Wires({ ws }: { ws: Workspace }) {
  const selection = useApp((s) => s.selection)
  const hot = useFleet((s) => s.hot)
  const rectOf = (id: string): Rect | undefined => ws.nodes.find((n) => n.id === id) ?? ws.groups.find((g) => g.id === id)
  return (
    <svg className="wires" width="1" height="1">
      {ws.wires.map((w) => {
        const a = rectOf(w.from)
        const b = rectOf(w.to)
        if (!a || !b) return null
        const p1 = edgePoint(a, center(b))
        const p2 = edgePoint(b, center(a))
        const dx = (p2.x - p1.x) * 0.45
        const d = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`
        const sel = selection.includes(w.id)
        return (
          <g key={w.id} className={`wire ${sel ? 'selected' : ''} ${hot[`${w.from}>${w.to}`] ? 'hot' : ''}`} onPointerDown={(e) => (e.stopPropagation(), useApp.getState().setSelection([w.id]))}>
            <path d={d} className="wire-hit" />
            <path d={d} className="wire-line" />
            <circle r="4" className="wire-end" cx={p1.x} cy={p1.y} />
            <circle r="4" className="wire-end" cx={p2.x} cy={p2.y} />
            <circle r="3.5" className="wire-pulse">
              <animateMotion dur="2.6s" repeatCount="indefinite" path={d} />
            </circle>
          </g>
        )
      })}
    </svg>
  )
})
