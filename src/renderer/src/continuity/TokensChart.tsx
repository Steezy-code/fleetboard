import { useMemo, useState } from 'react'
import type { Tot, UsageAgent } from './types'
import { USAGE_AGENT_IDS, USAGE_AGENT_META } from './usageStore'
import { fmtDay, fmtTokens } from './format'

export type TokenMetric = 'all' | 'io' | 'out'
export const metricOf = (t: Tot, m: TokenMetric) => (m === 'all' ? t.total : m === 'io' ? t.input + t.output : t.output)

/** Last-30-days stacked bar chart, one stack per day, one segment per agent. Hand-made SVG. */
export function TokensChart({ days, metric }: { days: ({ date: string } & Record<UsageAgent, Tot>)[]; metric: TokenMetric }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 352
  const H = 150
  const left = 34
  const bottom = 18
  const plotW = W - left
  const plotH = H - bottom - 6

  const { max, ticks } = useMemo(() => {
    const totals = days.map((d) => USAGE_AGENT_IDS.reduce((s, a) => s + metricOf(d[a], metric), 0))
    const raw = Math.max(1, ...totals)
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const nice = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= raw) ?? raw
    return { max: nice, ticks: [0, nice / 2, nice] }
  }, [days, metric])

  const bw = plotW / days.length
  const barW = Math.max(2, bw - 3)
  const h = hover !== null ? days[hover] : null

  return (
    <div className="tokens-chart" onMouseLeave={() => setHover(null)}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        {ticks.map((t) => {
          const y = 6 + plotH - (t / max) * plotH
          return (
            <g key={t}>
              <line x1={left} x2={W} y1={y} y2={y} className="chart-grid" />
              <text x={left - 6} y={y + 3} textAnchor="end" className="chart-axis">
                {fmtTokens(t, 0)}
              </text>
            </g>
          )
        })}
        {days.map((d, i) => {
          let y = 6 + plotH
          const x = left + i * bw + (bw - barW) / 2
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={left + i * bw} y={0} width={bw} height={H - bottom} fill="transparent" />
              {USAGE_AGENT_IDS.map((a) => {
                const v = metricOf(d[a], metric)
                if (!v) return null
                const hh = Math.max(1, (v / max) * plotH)
                y -= hh
                return <rect key={a} x={x} y={y} width={barW} height={hh} rx={1.5} fill={USAGE_AGENT_META[a].color} opacity={hover === null || hover === i ? 1 : 0.45} />
              })}
            </g>
          )
        })}
        {[0, Math.floor(days.length / 2), days.length - 1].map((i) =>
          days[i] ? (
            <text key={i} x={left + i * bw + bw / 2} y={H - 4} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} className="chart-axis">
              {fmtDay(days[i].date)}
            </text>
          ) : null
        )}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: `${Math.min(78, Math.max(24, ((left + hover! * bw + bw / 2) / W) * 100))}%` }}>
          <div className="chart-tip-title">{fmtDay(h.date, true)}</div>
          {USAGE_AGENT_IDS.filter((a) => metricOf(h[a], metric) > 0).map((a) => (
            <div key={a} className="row" style={{ gap: 6 }}>
              <span className="dot" style={{ background: USAGE_AGENT_META[a].color }} />
              <span className="grow">{USAGE_AGENT_META[a].label}</span>
              <span className="mono">{fmtTokens(metricOf(h[a], metric))}</span>
            </div>
          ))}
          {!USAGE_AGENT_IDS.some((a) => metricOf(h[a], metric) > 0) && <div className="muted">No activity</div>}
        </div>
      )}
    </div>
  )
}
