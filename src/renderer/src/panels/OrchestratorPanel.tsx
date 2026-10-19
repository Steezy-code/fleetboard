import { Network, Plus, Spline } from 'lucide-react'
import { useApp } from '../state/store'
import { Drawer } from '../ui/Modal'
import { OrchestratorView } from '../orchestration/OrchestratorView'
import { plural, useFleet, useStatuses } from '../orchestration/fleet'
import { ensureOrchestratorNode, startConnect } from '../orchestration/connect'

/** Orchestrator drawer: every console in the project, grouped by team, with one command input. */
export default function OrchestratorPanel() {
  const fleet = useFleet()
  const statuses = useStatuses(fleet.consoles.map((c) => c.id))
  const working = statuses.filter((s) => s === 'working').length
  const teams = fleet.teams.filter((t) => t.memberIds.length).length

  return (
    <Drawer
      title={
        <span className="row" style={{ gap: 10 }}>
          Orchestrator
          <span className="orch-count mono">
            ◎ {working}/{fleet.consoles.length} working
          </span>
        </span>
      }
      icon={<Network size={15} color="var(--accent)" />}
      width={392}
      headerRight={
        <>
          <button className="icon-btn sm" title="Compose a team" onClick={() => useApp.getState().openPanel('composer')}>
            <Plus size={14} />
          </button>
          <button
            className="btn sm"
            title="Wire the orchestrator to teams on the board"
            onClick={() => {
              const id = ensureOrchestratorNode()
              if (id) startConnect(id)
            }}
          >
            <Spline size={12} /> Connect
          </button>
        </>
      }
    >
      <div className="orch-drawer">
        <div className="orch-meta">
          {plural(fleet.consoles.length, 'agent')} · {plural(teams, 'group')}
        </div>
        <OrchestratorView
          scope="drawer"
          empty={
            <div className="empty">
              <div>No agents on the board yet.</div>
              <button className="btn sm primary" onClick={() => useApp.getState().openPanel('composer')}>
                Compose a team
              </button>
            </div>
          }
        />
      </div>
    </Drawer>
  )
}
