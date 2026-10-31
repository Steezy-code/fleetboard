import { useRef } from 'react'
import { useApp, activeWs, stopCameraAnimation } from '../state/store'
import { agentColor } from '../engine/consoles'
import { ROLE_TINT } from '@shared/types'
import { groupBox, hiddenIds, occupied } from '../board/place'
import { useMotion } from '../ui/motion'

const W = 220
const H = 140
const PAD = 10

const STATUS_FILL: Record<string, string> = {
  working: 'var(--accent)',
  'needs-you': 'var(--warn)',
  idle: 'var(--ok)',
  paused: 'var(--muted)'
}

/** Overview of the whole board with the current view; click or drag to move the view there. */
export function Minimap() {
  const ref = useRef<HTMLDivElement>(null)
  const show = useApp((s) => s.settings.showMinimap)
  const ws = useApp((s) => s.project?.workspaces.find((w) => w.id === s.project?.activeWorkspaceId))
  const vp = useApp((s) => s.viewport)
  const statuses = useApp((s) => s.statuses)
  const motion = useMotion()
  if (!show || !ws || (!ws.nodes.length && !ws.groups.length && !ws.ink.length)) return null

  const cam = ws.camera
  const view = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, w: vp.w / cam.zoom, h: vp.h / cam.zoom }
  const folded = hiddenIds(ws)
  const boxes = [...occupied(ws), view]
  const l = Math.min(...boxes.map((b) => b.x))
  const t = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const b = Math.max(...boxes.map((b) => b.y + b.h))
  const k = Math.min((W - PAD * 2) / (r - l || 1), (H - PAD * 2) / (b - t || 1))
  const ox = PAD + ((W - PAD * 2) - (r - l) * k) / 2
  const oy = PAD + ((H - PAD * 2) - (b - t) * k) / 2
  const mx = (x: number) => ox + (x - l) * k
  const my = (y: number) => oy + (y - t) * k

  const moveTo = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect()
    const wx = (clientX - rect.left - ox) / k + l
    const wy = (clientY - rect.top - oy) / k + t
    const c = activeWs()!.camera
    useApp.getState().setCamera({ x: vp.w / 2 - wx * c.zoom, y: vp.h / 2 - wy * c.zoom })
  }

  return (
    <div
      ref={ref}
      className="minimap"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        stopCameraAnimation()
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        moveTo(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => e.buttons === 1 && moveTo(e.clientX, e.clientY)}
      onWheel={(e) => {
        e.stopPropagation()
        useApp.getState().zoomAt(Math.exp(-e.deltaY * 0.0016))
      }}
      title="Click or drag to move the view"
    >
      <svg viewBox={`0 0 ${W} ${H}`}>
        {ws.groups.map((g) => ({ ...g, ...groupBox(g) })).map((g) => (
          <rect key={g.id} x={mx(g.x)} y={my(g.y)} width={g.w * k} height={g.h * k} rx={3} fill="none" stroke={ROLE_TINT[g.role]} strokeOpacity={0.6} strokeDasharray="2 2" />
        ))}
        {ws.ink.map((i) => (
          <rect key={i.id} x={mx(i.x)} y={my(i.y)} width={Math.max(1, i.w * k)} height={Math.max(1, i.h * k)} fill="none" style={{ stroke: 'var(--text)' }} strokeOpacity={0.35} />
        ))}
        {ws.nodes.filter((n) => !folded.has(n.id)).map((n) => {
          const isConsole = n.type === 'console'
          const st = statuses[n.id]
          const fill = isConsole ? (st ? STATUS_FILL[st] : undefined) ?? 'var(--line-3)' : 'var(--line-2)'
          return (
            <rect
              key={n.id}
              x={mx(n.x)}
              y={my(n.y)}
              width={Math.max(2, n.w * k)}
              height={Math.max(2, n.h * k)}
              rx={1.5}
              style={{ fill }}
              fillOpacity={isConsole ? 0.55 : 0.8}
              stroke={isConsole ? agentColor(n.data.agentId) : 'none'}
              strokeWidth={0.8}
            />
          )
        })}
        <rect className="mm-view" x={mx(view.x)} y={my(view.y)} width={view.w * k} height={view.h * k} rx={2} />
        {ws.nodes.filter((n) => statuses[n.id] === 'needs-you').map((n) => {
          const group = folded.has(n.id) ? ws.groups.find((g) => g.id === n.groupId) : undefined
          const box = group ? groupBox(group) : n
          return <g key={n.id} className={`mm-attention ${motion === 'off' ? 'still' : ''}`} transform={`translate(${mx(box.x + box.w / 2)},${my(box.y)})`}>
            <circle className="mm-attention-ring" r="4" /><circle className="mm-attention-ring second" r="4" /><circle r="2.5" className="mm-attention-dot" />
          </g>
        })}
      </svg>
    </div>
  )
}
