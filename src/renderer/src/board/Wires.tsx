import { memo } from 'react'
import type { Workspace } from '@shared/types'

/** What wires are drawn from. Not the workspace itself: its camera changes on every pan frame, and the memo below would never hold. */
type WireSpace = Pick<Workspace, 'nodes' | 'groups' | 'wires'>
import { center, edgePoint, type Rect } from './geometry'
import { groupBox, hiddenIds } from './place'
import { useApp } from '../state/store'
import { useFleet } from '../engine/fleet'

/** Curved orchestrator wires between board items, with a dot travelling along each. */
export const Wires = memo(function Wires({ nodes, groups, wires }: WireSpace) {
  const ws = { nodes, groups, wires }
  const selection = useApp((s) => s.selection)
  const hot = useFleet((s) => s.hot)
  const folded = hiddenIds(ws)
  // a wire to a console in a collapsed group ends at the group's header, where the console now is
  const rectOf = (id: string): Rect | undefined => {
    const n = ws.nodes.find((x) => x.id === id)
    const g = ws.groups.find((x) => x.id === (n && folded.has(n.id) ? n.groupId : id))
    return g ? groupBox(g) : n
  }
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
