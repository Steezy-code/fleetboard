import { useMemo, useState } from 'react'
import { fmtDay, fmtTokens } from './format'

/** GitHub-style activity grid: one column per week, Sunday on top, accent scale by quartile. */
export function Heatmap({ days, color = 'var(--accent)' }: { days: { date: string; total: number }[]; color?: string }) {
  const [hover, setHover] = useState<{ date: string; total: number; x: number; y: number } | null>(null)
  const cell = 5.6
  const gap = 1.1
  const step = cell + gap
  const top = 13

  const { cols, months, levels, width } = useMemo(() => {
    const first = days.length ? new Date(days[0].date + 'T00:00:00') : new Date()
    const lead = first.getDay()
    const cells = [...Array(lead).fill(null), ...days] as ({ date: string; total: number } | null)[]
    const cols: ({ date: string; total: number } | null)[][] = []
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7))
    const months: { x: number; label: string }[] = []
    let lastMonth = -1
    cols.forEach((col, ci) => {
      const d = col.find(Boolean)
      if (!d) return
      const m = new Date(d.date + 'T00:00:00').getMonth()
      if (m !== lastMonth) {
        // skip a label squeezed against the previous one
        if (!months.length || ci * step - months[months.length - 1].x > 22)
          months.push({ x: ci * step, label: new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }) })
        lastMonth = m
      }
    })
    const nz = days.map((d) => d.total).filter((v) => v > 0).sort((a, b) => a - b)
    const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0
    const levels = [q(0.25), q(0.5), q(0.75)]
    return { cols, months, levels, width: cols.length * step }
  }, [days, step])

  const level = (v: number) => (v <= 0 ? 0 : v <= levels[0] ? 1 : v <= levels[1] ? 2 : v <= levels[2] ? 3 : 4)
  const OPACITY = [0, 0.28, 0.5, 0.75, 1]

  return (
    <div className="heatmap" onMouseLeave={() => setHover(null)}>
      <svg width="100%" viewBox={`0 0 ${width} ${top + 7 * step}`} preserveAspectRatio="xMinYMin meet">
        {months.map((m) => (
          <text key={m.x} x={m.x} y={8} className="heatmap-month">
            {m.label}
          </text>
        ))}
        {cols.map((col, ci) =>
          col.map((d, ri) =>
            d ? (
              <rect
                key={d.date}
                x={ci * step}
                y={top + ri * step}
                width={cell}
                height={cell}
                rx={1.3}
                fill={level(d.total) ? color : 'var(--line)'}
                fillOpacity={level(d.total) ? OPACITY[level(d.total)] : 1}
                onMouseEnter={() => setHover({ ...d, x: ci * step, y: ri })}
              />
            ) : null
          )
        )}
      </svg>
      <div className="heatmap-foot">
        <span className="muted small">{hover ? `${fmtDay(hover.date, true)} · ${hover.total ? fmtTokens(hover.total) + ' tokens' : 'no activity'}` : 'Last 52 weeks'}</span>
        <span className="spacer" />
        <span className="dim small">Less</span>
        {OPACITY.map((o, i) => (
          <span key={i} className="heatmap-key" style={{ background: i ? color : 'var(--line)', opacity: i ? o : 1 }} />
        ))}
        <span className="dim small">More</span>
      </div>
    </div>
  )
}
