import { Circle, CircleCheck, CircleDashed, CircleDot, TriangleAlert } from 'lucide-react'
import type { NodeProps } from './types'
import { useFleet } from '../engine/fleet'
import { useApp } from '../state/store'
import { useNow } from '../lib/useNow'
import { elapsedLabel, overEstimate, type Timed } from '@shared/live'

const ICON = {
  todo: <Circle size={13} className="pl-todo" />,
  doing: <CircleDashed size={13} className="pl-doing spin-slow" />,
  review: <CircleDot size={13} className="pl-review" />,
  done: <CircleCheck size={13} className="pl-done" />,
  blocked: <TriangleAlert size={13} className="pl-blocked" />
}

/** "12 min, est 5", coloured once it is past the estimate: the estimate colours the figure and does nothing else. */
function Elapsed({ t, now }: { t: Timed; now: number }) {
  const label = elapsedLabel(t, now)
  if (!label) return null
  return <span className={`plan-time ${overEstimate(t, now) ? 'over' : ''}`}>{label}</span>
}

/** The lead's live plan: goal, tasks with owners and how long each has taken, and who is on the team. */
export default function PlanNode({ node }: NodeProps<{ leadId: string }>) {
  const fleet = useFleet((s) => s.state)
  const statuses = useApp((s) => s.statuses)
  const lead = fleet?.members[node.data.leadId]
  const crew = Object.values(fleet?.members ?? {}).filter((m) => m.leadId === node.data.leadId && m.status !== 'closed')
  const tasks = fleet?.tasks ?? []
  const done = tasks.filter((t) => t.status === 'done').length
  const now = useNow()
  // the job's own clock runs from the Lead's start to the Ready card, against the charter's estimate
  const job: Timed | null = lead ? { startedAt: lead.createdAt, endedAt: fleet?.ready?.leadId === lead.id ? fleet.ready.at : undefined, estimate: fleet?.charter?.estimate } : null
  return (
    <div className="plan-body scrollable">
      {lead?.task && <div className="plan-goal">{lead.task}</div>}
      {job && (
        <div className="plan-meta">
          <Elapsed t={job} now={now} />
        </div>
      )}
      {tasks.length > 0 && (
        <div className="plan-progress">
          <div style={{ width: `${(done / tasks.length) * 100}%` }} />
        </div>
      )}
      <div className="plan-list">
        {tasks.map((t) => (
          <div key={t.id} className={`plan-task ${t.status}`}>
            {ICON[t.status]}
            <span className="grow">{t.title}</span>
            <Elapsed t={t} now={now} />
            {t.owner && <span className="plan-owner">{fleet?.members[t.owner]?.name ?? ''}</span>}
          </div>
        ))}
        {!tasks.length && <div className="muted small">{lead?.name ?? 'The lead'} is reading the repo and planning…</div>}
      </div>
      {crew.length > 0 && (
        <div className="plan-crew">
          {crew.map((m) => (
            <span key={m.id} className={`plan-member st-${statuses[m.id] ?? 'exited'}`} title={m.task}>
              <span className="status-dot" />
              {m.name}
              <span className="dim">{m.role === 'reviewer' ? 'review' : m.status}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
