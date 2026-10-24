import { useEffect } from 'react'
import { useApp } from '../state/store'
import { hasBudget, pctTone, startUsageWatch, toneColor, usedPct, USAGE_AGENT_IDS, USAGE_AGENT_META, useUsage } from '../continuity/usageStore'
import { fmtReset, fmtTokens } from '../continuity/format'
import type { UsageAgent } from '../continuity/types'

/**
 * Top-bar pill: the tokens this 5-hour window has moved, and when it resets. A percentage and its ring
 * appear only against a budget the user set — the real plan limit is not on this machine, so a share of
 * it would be a share of a number nobody chose. Click opens the usage drawer.
 */
export function UsagePill() {
  const limits = useUsage((s) => s.limits)
  const budgets = useUsage((s) => s.budgets)
  const defaultAgent = useApp((s) => s.settings.defaultAgent)

  useEffect(() => startUsageWatch(), [])

  // the busiest active window: by share of a budget where there is one, else by tokens moved
  const active = USAGE_AGENT_IDS.filter((a) => limits[a]?.session.active)
  const rank = (a: UsageAgent) => (hasBudget(budgets[a]) ? usedPct(limits[a], budgets[a]) : (limits[a]?.session.tokens ?? 0) / Number.MAX_SAFE_INTEGER)
  const agent: UsageAgent =
    active.sort((a, b) => rank(b) - rank(a))[0] ??
    ((USAGE_AGENT_IDS as string[]).includes(defaultAgent) ? (defaultAgent as UsageAgent) : 'claude')
  const l = limits[agent]
  const budgeted = hasBudget(budgets[agent])
  const pct = usedPct(l, budgets[agent])
  const color = toneColor(pct)
  // the same thresholds as the colour, from the one place that defines them
  const tone = pctTone(pct)
  const r = 6
  const c = 2 * Math.PI * r
  const label = l?.session.active ? `resets ${fmtReset(l.session.resetsAt)}` : 'usage'
  const title = USAGE_AGENT_IDS.filter((a) => limits[a]?.lastActivity)
    .map((a) => {
      const x = limits[a]!
      const share = hasBudget(budgets[a]) ? `${Math.round(usedPct(x, budgets[a]) * 100)}% of your 5h budget, ` : ''
      return `${USAGE_AGENT_META[a].label}: ${x.session.active ? `${share}${fmtTokens(x.session.tokens)} this window, resets ${fmtReset(x.session.resetsAt)}` : 'no active session'}`
    })
    .join('\n')

  return (
    <button
      className={`usage-pill ${tone === 'ok' ? '' : tone}`}
      title={(title || 'No local session logs yet') + '\nEstimated from local session logs'}
      onClick={() => useApp.getState().openDrawer('usage')}
    >
      <svg width={16} height={16} viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={r} fill="none" stroke="var(--line-2)" strokeWidth={2.4} />
        {budgeted && pct > 0 && (
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
      {l?.session.active && <span className="usage-pill-pct mono">{budgeted ? `${Math.round(pct * 100)}%` : fmtTokens(l.session.tokens)}</span>}
    </button>
  )
}
