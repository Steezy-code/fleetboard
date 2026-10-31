import { memo, useLayoutEffect, useRef } from 'react'
import type { Workspace } from '@shared/types'

/** What wires are drawn from. Not the workspace itself: its camera changes on every pan frame, and the memo below would never hold. */
type WireSpace = Pick<Workspace, 'nodes' | 'groups' | 'wires'>
import { center, edgePoint, type Rect } from './geometry'
import { groupBox, hiddenIds } from './place'
import { useApp } from '../state/store'
import { useFleet } from '../engine/fleet'
import { useMotion } from '../ui/motion'

function MessagePulse({ path, end, full }: { path: string; end: { x: number; y: number }; full: boolean }) {
  const ref = useRef<SVGGElement>(null)
  useLayoutEffect(() => {
    // SVG clocks start when the board mounts, not when a message arrives.
    ref.current?.querySelectorAll<SVGAnimationElement>('animate, animateMotion').forEach((animation) => {
      animation.beginElementAt(Number(animation.dataset.delay ?? 0))
    })
  }, [])
  return <g ref={ref} className="wire-message" pointerEvents="none">
    <circle r={full ? 6 : 2.5} className="wire-pulse" opacity="0">
      <animate begin="indefinite" attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.85;1" dur={full ? '1.1s' : '0.65s'} fill="freeze" />
      <animateMotion begin="indefinite" dur={full ? '1.1s' : '0.65s'} path={path} fill="freeze" />
    </circle>
    {full && <circle cx={end.x} cy={end.y} r="4" className="wire-arrival" opacity="0">
      <animate begin="indefinite" data-delay="0.95" attributeName="r" values="4;26" dur="0.75s" fill="freeze" />
      <animate begin="indefinite" data-delay="0.95" attributeName="opacity" values="0.9;0" dur="0.75s" fill="freeze" />
    </circle>}
  </g>
}

/** Curved orchestrator wires between board items, with a dot travelling along each. */
export const Wires = memo(function Wires({ nodes, groups, wires }: WireSpace) {
  const ws = { nodes, groups, wires }
  const selection = useApp((s) => s.selection)
  const newWire = useApp((s) => s.newWire)
  const hot = useFleet((s) => s.hot)
  const motion = useMotion()
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
        const traffic = [
          { stamp: hot[`${w.from}>${w.to}`], path: d, end: p2, direction: 'forward' },
          { stamp: hot[`${w.to}>${w.from}`], path: `M${p2.x},${p2.y} C${p2.x - dx},${p2.y} ${p1.x + dx},${p1.y} ${p1.x},${p1.y}`, end: p1, direction: 'reverse' }
        ].filter((event) => event.stamp)
        return (
          <g key={w.id} data-wire-from={w.from} className={`wire ${sel ? 'selected' : ''} ${traffic.length ? 'hot' : ''}`} onPointerDown={(e) => (e.stopPropagation(), useApp.getState().setSelection([w.id]))}>
            <path d={d} className="wire-hit" />
            <path d={d} className="wire-line" />
            {/* a wire just made by hand, lit from one end to the other once */}
            {w.id === newWire && <path d={d} className="wire-draw" pathLength="1" />}
            <circle r="4" className="wire-end" cx={p1.x} cy={p1.y} />
            <circle r="4" className="wire-end" cx={p2.x} cy={p2.y} />
            {motion !== 'off' && traffic.map((event) => (
              <MessagePulse key={`${event.direction}-${event.stamp}`} path={event.path} end={event.end} full={motion === 'full'} />
            ))}
          </g>
        )
      })}
    </svg>
  )
})
