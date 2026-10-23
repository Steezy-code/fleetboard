import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Gauge, Info, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Drawer, Seg } from '../ui/Modal'
import { Ring } from '../continuity/Ring'
import { Heatmap } from '../continuity/Heatmap'
import { metricOf, TokensChart, type TokenMetric } from '../continuity/TokensChart'
import { startUsageWatch, toneColor, usedPct, USAGE_AGENT_IDS, USAGE_AGENT_META, useUsage } from '../continuity/usageStore'
import { fmtDay, fmtDuration, fmtInt, fmtReset, fmtTokens, fmtUntil, prettyModel } from '../continuity/format'
import type { UsageAgent } from '../continuity/types'

/** Usage drawer: plan-window estimates, activity heatmap, stats, and a tokens sub-view. */
export default function UsagePanel({ agent: initial }: { agent?: UsageAgent }) {
  const [agent, setAgent] = useState<UsageAgent>(initial ?? 'claude')
  const [view, setView] = useState<'overview' | 'tokens'>('overview')
  const report = useUsage((s) => s.report)
  const loading = useUsage((s) => s.loading)
  const progress = useUsage((s) => s.progress)

  useEffect(() => {
    startUsageWatch()
    const s = useUsage.getState()
    s.refreshReport()
    s.refreshLimits()
  }, [])

  const refresh = () => useUsage.getState().refreshReport(true)

  if (view === 'tokens')
    return (
      <Drawer
        title={
          <span className="row" style={{ gap: 6 }}>
            <button className="icon-btn sm" onClick={() => setView('overview')} title="Back">
              <ArrowLeft size={14} />
            </button>
            tokens
          </span>
        }
        headerRight={<RefreshBtn loading={loading} onClick={refresh} />}
      >
        <TokensView />
      </Drawer>
    )

  return (
    <Drawer title="usage" icon={<Gauge size={14} color="var(--accent)" />} headerRight={<RefreshBtn loading={loading} onClick={refresh} />}>
      <div className="usage-tabs">
        {USAGE_AGENT_IDS.map((a) => (
          <button key={a} className={`usage-tab ${agent === a ? 'on' : ''}`} onClick={() => setAgent(a)}>
            <span className="dot" style={{ background: USAGE_AGENT_META[a].color }} />
            {USAGE_AGENT_META[a].label}
          </button>
        ))}
      </div>
      {progress && (
        <div className="usage-progress">
          <div className="muted small">Reading session logs… {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</div>
          <div className="bar">
            <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        </div>
      )}
      <PlanCard agent={agent} />
      <ActivityCard agent={agent} />
      <StatsGrid agent={agent} />
      <button className="usage-link" onClick={() => setView('tokens')}>
        <span className="grow">
          <span>Tokens</span>
          <span className="muted small"> · last 30 days, by agent</span>
        </span>
        <ChevronRight size={14} />
      </button>
      <div className="usage-foot">
        <span className="dim small">local session logs{report ? ` · ${fmtReset(report.generatedAt)}` : ''}</span>
      </div>
    </Drawer>
  )
}

function RefreshBtn({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn sm" title="Rescan session logs" onClick={onClick}>
      <RefreshCw size={13} className={loading ? 'spin' : ''} />
    </button>
  )
}

function PlanCard({ agent }: { agent: UsageAgent }) {
  const l = useUsage((s) => s.limits[agent])
  const budget = useUsage((s) => s.budgets[agent])
  const [editing, setEditing] = useState(false)
  const sPct = usedPct(l, budget, 'session')
  const wPct = usedPct(l, budget, 'week')
  const sess = l?.session
  const week = l?.week

  return (
    <div className="usage-card">
      <div className="usage-ring-row">
        <Ring pct={sPct} size={112} stroke={10} color={toneColor(sPct)}>
          <div className="ring-pct">
            {sess?.active ? Math.round(sPct * 100) : 0}
            <span>%</span>
          </div>
          <div className="ring-sub">{sess?.active ? fmtTokens(sess.tokens) : 'idle'}</div>
        </Ring>
        <div className="grow">
          <div className="usage-h">Current session</div>
          {sess?.active ? (
            <>
              <div className="muted">Resets {fmtReset(sess.resetsAt)}</div>
              <div className="dim small">{fmtUntil(sess.resetsAt)} · window opened {fmtReset(sess.start)}</div>
            </>
          ) : (
            <div className="muted small">No active 5-hour window. It opens with your next message.</div>
          )}
          <div className="usage-est">
            <Info size={11} /> Estimate from local logs
          </div>
        </div>
      </div>

      <div className="usage-bars">
        <UsageBar
          label="Current week (all models)"
          pct={wPct}
          right={week?.active ? `Resets ${fmtReset(week.resetsAt)}` : 'not started'}
          sub={week?.active ? `${fmtTokens(week.tokens)} of ${fmtTokens(budget.week)}` : undefined}
        />
        {week?.active &&
          week.byModel.slice(0, 4).map((m) => (
            <UsageBar
              key={m.model}
              label={prettyModel(m.model)}
              pct={budget.week ? m.tokens / budget.week : 0}
              right={fmtTokens(m.tokens)}
              thin
            />
          ))}
      </div>

      <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setEditing(!editing)}>
        <SlidersHorizontal size={12} /> {editing ? 'Done' : 'Adjust budget'}
      </button>
      {editing && <BudgetEditor key={agent} agent={agent} />}
    </div>
  )
}

function UsageBar({ label, pct, right, sub, thin }: { label: string; pct: number; right?: string; sub?: string; thin?: boolean }) {
  return (
    <div className={`usage-bar ${thin ? 'thin' : ''}`}>
      <div className="row">
        <span className="grow">{label}</span>
        <span className="mono small">{Math.round(pct * 100)}%</span>
      </div>
      <div className="bar">
        <span style={{ width: `${Math.min(100, pct * 100)}%`, background: toneColor(pct) }} />
      </div>
      {(right || sub) && (
        <div className="row dim small">
          <span className="grow">{sub}</span>
          <span>{right}</span>
        </div>
      )}
    </div>
  )
}

const BUDGET_PRESETS = [2e6, 6e6, 15e6, 40e6]
const CEILINGS = [0.8, 0.9, 0.95, 1, 0]

function BudgetEditor({ agent }: { agent: UsageAgent }) {
  const budget = useUsage((s) => s.budgets[agent])
  const set = (k: 'session' | 'week', v: string) => {
    const n = Number(v.replace(/[^\d.]/g, '')) * 1e6
    if (Number.isFinite(n) && n > 0) useUsage.getState().setBudget(agent, { [k]: n })
  }
  return (
    <div className="budget-editor">
      <div className="muted small" style={{ lineHeight: 1.45 }}>
        The CLIs don't write plan limits to disk, so the % compares tokens in each window (input + output + cache writes; cache reads
        excluded) with a budget you set. Tune it until it matches <code className="mono">/usage</code>.
      </div>
      <label className="budget-row">
        <span className="grow">5-hour session</span>
        <input key={budget.session} className="input sm-input mono" defaultValue={budget.session / 1e6} onBlur={(e) => set('session', e.target.value)} />
        <span className="dim small">M tokens</span>
      </label>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {BUDGET_PRESETS.map((p) => (
          <button key={p} className={`chip sm-chip ${budget.session === p ? 'on' : ''}`} onClick={() => useUsage.getState().setBudget(agent, { session: p })}>
            {fmtTokens(p)}
          </button>
        ))}
      </div>
      <label className="budget-row">
        <span className="grow">Week</span>
        <input key={budget.week} className="input sm-input mono" defaultValue={budget.week / 1e6} onBlur={(e) => set('week', e.target.value)} />
        <span className="dim small">M tokens</span>
      </label>
      <label className="budget-row">
        <span className="grow">Stop spending by itself at</span>
        <select
          className="input sm-input"
          value={budget.ceiling}
          onChange={(e) => useUsage.getState().setBudget(agent, { ceiling: Number(e.target.value) })}
        >
          {CEILINGS.map((c) => (
            <option key={c} value={c}>
              {c ? `${Math.round(c * 100)}% of either budget` : 'never'}
            </option>
          ))}
        </select>
      </label>
      <div className="muted small" style={{ lineHeight: 1.45 }}>
        At that point loops stop typing, goal judges stop running and CI failures stop being handed to an agent — the things that spend
        while you are not watching. Your own prompts always go through.
      </div>
    </div>
  )
}

function ActivityCard({ agent }: { agent: UsageAgent }) {
  const u = useUsage((s) => s.report?.agents[agent])
  return (
    <div className="usage-card">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="label grow">Activity</span>
        {u && <span className="dim small">{u.activeDays} active days</span>}
      </div>
      {u ? <Heatmap days={u.heatmap} color={USAGE_AGENT_META[agent].color} /> : <div className="usage-skeleton" />}
    </div>
  )
}

function StatsGrid({ agent }: { agent: UsageAgent }) {
  const u = useUsage((s) => s.report?.agents[agent])
  const report = useUsage((s) => s.report)
  if (!report) return null
  if (!u || !u.lifetime.total) {
    const root = report.roots.find((r) => r.agent === agent)
    return (
      <div className="usage-card empty" style={{ padding: 22 }}>
        <div>No {USAGE_AGENT_META[agent].label} sessions found.</div>
        <div className="dim small mono">{root?.dir}</div>
      </div>
    )
  }
  const stats: [string, string, string?][] = [
    ['Favorite model', prettyModel(u.favoriteModel)],
    ['Total tokens', fmtTokens(u.lifetime.total), `${fmtTokens(u.lifetime.output)} output`],
    ['Sessions', fmtInt(u.sessions)],
    ['Active days', fmtInt(u.activeDays)],
    ['Most active day', u.peakDay ? fmtDay(u.peakDay.date) : '—', u.peakDay ? fmtTokens(u.peakDay.total) : undefined],
    ['Longest session', u.longestSession ? fmtDuration(u.longestSession.ms) : '—', u.longestSession ? fmtDay(u.longestSession.date) : undefined],
    ['Current streak', `${u.currentStreak} day${u.currentStreak === 1 ? '' : 's'}`],
    ['Longest streak', `${u.longestStreak} day${u.longestStreak === 1 ? '' : 's'}`]
  ]
  return (
    <div className="stat-grid">
      {stats.map(([k, v, sub]) => (
        <div key={k} className="stat">
          <div className="stat-k">{k}</div>
          <div className="stat-v">{v}</div>
          {sub && <div className="stat-sub">{sub}</div>}
        </div>
      ))}
    </div>
  )
}

function TokensView() {
  const report = useUsage((s) => s.report)
  const loading = useUsage((s) => s.loading)
  const [metric, setMetric] = useState<TokenMetric>('all')
  const [span, setSpan] = useState<'30' | 'all'>('30')
  if (!report) return <div className="empty">{loading ? 'Reading session logs…' : 'No data yet'}</div>
  const days = report.days.slice(-30)
  const sum30 = USAGE_AGENT_IDS.reduce((s, a) => s + days.reduce((x, d) => x + metricOf(d[a], metric), 0), 0)
  const byAgent = USAGE_AGENT_IDS.map((a) => {
    const u = report.agents[a]
    const t = span === '30' ? u.last30 : u.lifetime
    return { a, v: metricOf(t, metric), t }
  })
  const maxA = Math.max(1, ...byAgent.map((x) => x.v))

  return (
    <>
      <div className="usage-card">
        <div className="row" style={{ marginBottom: 4 }}>
          <span className="label grow">Last 30 days</span>
          <span className="mono small">{fmtTokens(sum30)}</span>
        </div>
        <Seg<TokenMetric>
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'all', label: 'All tokens' },
            { value: 'io', label: 'In + out' },
            { value: 'out', label: 'Output' }
          ]}
        />
        <TokensChart days={days} metric={metric} />
        <div className="row" style={{ gap: 12 }}>
          {USAGE_AGENT_IDS.map((a) => (
            <span key={a} className="row small muted" style={{ gap: 5 }}>
              <span className="dot" style={{ background: USAGE_AGENT_META[a].color }} />
              {USAGE_AGENT_META[a].label}
            </span>
          ))}
        </div>
      </div>

      <div className="usage-card">
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="label grow">By agent</span>
          <Seg<'30' | 'all'>
            value={span}
            onChange={setSpan}
            options={[
              { value: '30', label: 'Last 30 days' },
              { value: 'all', label: 'All time' }
            ]}
          />
        </div>
        {byAgent.map(({ a, v, t }) => (
          <div key={a} className="agent-bar">
            <div className="row">
              <span className="dot" style={{ background: USAGE_AGENT_META[a].color }} />
              <span className="grow">{USAGE_AGENT_META[a].label}</span>
              <span className="mono">{fmtTokens(v)}</span>
            </div>
            <div className="bar">
              <span style={{ width: `${(v / maxA) * 100}%`, background: USAGE_AGENT_META[a].color }} />
            </div>
            {v > 0 && (
              <div className="dim small mono">
                in {fmtTokens(t.input)} · out {fmtTokens(t.output)} · cache {fmtTokens(t.cacheCreate + t.cacheRead)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="usage-foot row">
        <span className="dim small grow">local session logs · {fmtReset(report.generatedAt)}</span>
        <button className="btn ghost sm" onClick={() => useUsage.getState().refreshReport(true)}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
    </>
  )
}
