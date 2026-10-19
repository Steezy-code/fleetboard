import type { ReactNode } from 'react'

/** Progress ring drawn in SVG. pct is 0..1 (values above 1 draw a full ring). */
export function Ring({
  pct,
  size = 120,
  stroke = 10,
  color = 'var(--accent)',
  track = 'var(--panel-3)',
  children
}: {
  pct: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  children?: ReactNode
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, pct))
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        {p > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * p} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
        )}
      </svg>
      {children && <div className="ring-center">{children}</div>}
    </div>
  )
}
