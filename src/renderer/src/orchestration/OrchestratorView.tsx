import { useMemo } from 'react'
import { agentById } from '@shared/agents'
import { ROLE_TINT } from '@shared/types'
import { useApp } from '../state/store'
import { agentColor } from '../engine/consoles'
import { commandFrom, useCommandLog } from '../engine/orchestrator'
import { MentionInput } from './MentionInput'
import { STATUS_TEXT, goToItem, plural, statusOf, useFleet, useStatuses, type FleetConsole, type FleetTeam } from './fleet'

export function AgentAvatar({ agentId, size = 26 }: { agentId: string; size?: number }) {
  const a = agentById(agentId, useApp.getState().settings.customAgents)
  return (
    <span className="orch-avatar" style={{ width: size, height: size, background: agentColor(agentId), fontSize: size * 0.46 }}>
      {(a?.name ?? agentId).slice(0, 1).toUpperCase()}
    </span>
  )
}

function AgentRow({ c, multiWs }: { c: FleetConsole; multiWs: boolean }) {
  const status = useApp((s) => statusOf(s.statuses, s.live, c.id))
  const a = agentById(c.agentId, useApp.getState().settings.customAgents)
  return (
    <button className={`orch-row st-${status}`} onClick={() => goToItem(c.id, c.workspaceId)} title="Go to the console">
      <AgentAvatar agentId={c.agentId} />
      <span className="grow orch-row-text">
        <span className="orch-row-name">{c.name}</span>
        <span className="orch-row-sub">
          {a?.name ?? c.agentId} · {multiWs ? c.workspaceName : a?.vendor ?? 'custom'}
        </span>
      </span>
      <span className="status-pill">
        <span className="status-dot" />
        {STATUS_TEXT[status]}
      </span>
    </button>
  )
}

function TeamHeader({ team, ids }: { team?: FleetTeam; ids: string[] }) {
  const statuses = useStatuses(ids)
  const running = statuses.filter((s) => s === 'working').length
  const tint = team ? ROLE_TINT[team.role] : 'var(--muted)'
  return (
    <div className="orch-team" style={{ ['--tint' as any]: tint }}>
      <span className="dot" style={{ background: tint }} />
      <span className="orch-team-name">{team ? team.name : 'Loose consoles'}</span>
      <span className="spacer" />
      <span className="dim small mono">
        {running}/{ids.length} running
      </span>
    </div>
  )
}

/**
 * The orchestrator list + command input. `consoleIds` limits the roster (wired consoles for a node);
 * omitted = every console in the project.
 */
export function OrchestratorView({
  scope,
  consoleIds,
  placeholderCount,
  empty
}: {
  scope: string
  consoleIds?: string[]
  placeholderCount?: number
  empty?: React.ReactNode
}) {
  const fleet = useFleet()
  const roster = useMemo(() => {
    const set = consoleIds ? new Set(consoleIds) : null
    return set ? fleet.consoles.filter((c) => set.has(c.id)) : fleet.consoles
  }, [fleet, consoleIds])
  const sections = useMemo(() => {
    const out: { team?: FleetTeam; members: FleetConsole[] }[] = []
    for (const t of fleet.teams) {
      const members = roster.filter((c) => c.groupId === t.id)
      if (members.length) out.push({ team: t, members })
    }
    const loose = roster.filter((c) => !c.groupId || !fleet.teams.some((t) => t.id === c.groupId))
    if (loose.length) out.push({ members: loose })
    return out
  }, [fleet, roster])
  const log = useCommandLog((s) => s.logs[scope])
  const n = placeholderCount ?? roster.length
  const defaults = roster.map((c) => c.id)

  return (
    <div className="orch-view">
      <div className="orch-list scrollable no-board-wheel">
        {!roster.length && (empty ?? <div className="empty small">No consoles yet.</div>)}
        {sections.map((s) => (
          <div key={s.team?.id ?? 'loose'} className="orch-section">
            <TeamHeader team={s.team} ids={s.members.map((m) => m.id)} />
            {s.members.map((c) => (
              <AgentRow key={c.id} c={c} multiWs={fleet.multiWs} />
            ))}
          </div>
        ))}
      </div>
      {log && log.length > 0 && (
        <div className="orch-log scrollable no-board-wheel">
          {log.slice(0, 5).map((l) => (
            <div key={l.id} className="orch-log-row">
              <span className="orch-log-arrow">›</span>
              <span className="grow orch-log-text">{l.text}</span>
              <span className="dim small" title={l.to.join(', ')}>
                {l.to.length ? `→ ${l.to.length === 1 ? l.to[0] : plural(l.to.length, 'agent')}` : 'not sent'}
                {l.skipped ? ` · ${l.skipped} off` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <MentionInput
        placeholder={`Command ${plural(n, 'agent')}…  @ to direct`}
        disabled={!fleet.consoles.length}
        onSubmit={(text) => commandFrom(scope, text, defaults)}
      />
    </div>
  )
}
