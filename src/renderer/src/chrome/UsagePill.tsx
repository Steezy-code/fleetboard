import { useEffect } from 'react'
import { useApp } from '../state/store'
import { startUsageWatch, toneColor, usedPct, USAGE_AGENT_IDS, USAGE_AGENT_META, useUsage } from '../continuity/usageStore'
import { fmtReset, fmtTokens } from '../continuity/format'
import type { UsageAgent } from '../continuity/types'

/** Top-bar pill: current 5-hour session estimate as a mini ring + reset time. Click opens the usage drawer. */
export function UsagePill() {
  const limits = useUsage((s) => s.limits)
  const budgets = useUsage((s) => s.budgets)
  const defaultAgent = useApp((s) => s.settings.defaultAgent)

  useEffect(() => startUsageWatch(), [])

  // the agent with an active window and the highest share; else the default agent
  const active = USAGE_AGENT_IDS.filter((a) => limits[a]?.session.active)
  const agent: UsageAgent =
    active.sort((a, b) => usedPct(limits[b], budgets[b]) - usedPct(limits[a], budgets[a]))[0] ??
    ((USAGE_AGENT_IDS as string[]).includes(defaultAgent) ? (defaultAgent as UsageAgent) : 'claude')
  const l = limits[agent]
  const pct = usedPct(l, budgets[agent])
  const color = toneColor(pct)
  const r = 6
  const c = 2 * Math.PI * r
  const label = l?.session.active ? `resets ${fmtReset(l.session.resetsAt)}` : 'usage'
  const title = USAGE_AGENT_IDS.filter((a) => limits[a]?.lastActivity)
    .map((a) => {
      const x = limits[a]!
      return `${USAGE_AGENT_META[a].label}: ${x.session.active ? `${Math.round(usedPct(x, budgets[a]) * 100)}% of 5h budget (${fmtTokens(x.session.tokens)}), resets ${fmtReset(x.session.resetsAt)}` : 'no active session'}`
    })
    .join('\n')

  return (
    <button
      className={`usage-pill ${pct >= 0.9 ? 'danger' : pct >= 0.7 ? 'warn' : ''}`}
      title={(title || 'No local session logs yet') + '\nEstimated from local session logs'}
      onClick={() => useApp.getState().openDrawer('usage')}
    >
      <svg width={16} height={16} viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={r} fill="none" stroke="var(--line-2)" strokeWidth={2.4} />
        {pct > 0 && (
          <circle
            cx={8}
            cy={8}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray={`${c * Math.min(1, pct)} ${c}`}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
      <span>{label}</span>
      {l?.session.active && <span className="usage-pill-pct mono">{Math.round(pct * 100)}%</span>}
    </button>
  )
}
