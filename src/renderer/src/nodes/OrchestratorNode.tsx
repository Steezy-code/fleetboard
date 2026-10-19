import { useMemo } from 'react'
import { Spline } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { NodeProps } from './types'
import { useApp } from '../state/store'
import { wiredConsoleIds } from '../engine/orchestrator'
import { OrchestratorView } from '../orchestration/OrchestratorView'
import { plural, useStatuses } from '../orchestration/fleet'
import { startConnect } from '../orchestration/connect'

/** Orchestrator on the board: commands the teams / consoles wired to it. */
export default function OrchestratorNode({ node, zoom }: NodeProps) {
  // re-derive when wires or membership change
  const key = useApp(
    useShallow((s) => {
      const p = s.project
      const ws = p?.workspaces.find((w) => w.nodes.some((n) => n.id === node.id))
      if (!ws) return ''
      return (
        ws.wires.filter((w) => w.from === node.id || w.to === node.id).map((w) => w.from + w.to).join('|') +
        '#' +
        ws.nodes.filter((n) => n.type === 'console').map((n) => n.id + ':' + (n.groupId ?? '')).join(',')
      )
    })
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ids = useMemo(() => wiredConsoleIds(node.id), [key, node.id])
  const statuses = useStatuses(ids)
  const working = statuses.filter((s) => s === 'working').length
  const wiredTeams = useApp((s) => {
    const ws = s.project?.workspaces.find((w) => w.nodes.some((n) => n.id === node.id))
    return ws ? ws.wires.filter((w) => (w.from === node.id || w.to === node.id) && ws.groups.some((g) => g.id === w.from || g.id === w.to)).length : 0
  })

  if (zoom < 0.3) {
    return (
      <div className="orch-node-far">
        <div className="orch-node-far-ring">◎</div>
        <div>
          {working}/{ids.length}
        </div>
      </div>
    )
  }

  return (
    <div className="orch-node">
      <div className="orch-node-head">
        <span className="orch-count mono">
          ◎ {working}/{ids.length} working
        </span>
        <span className="spacer" />
        <button className="btn sm" onPointerDown={(e) => e.stopPropagation()} onClick={() => startConnect(node.id)}>
          <Spline size={12} /> Connect
        </button>
      </div>
      <div className="orch-meta">
        {plural(ids.length, 'agent')} · {plural(wiredTeams, 'group')}
      </div>
      <OrchestratorView
        scope={node.id}
        consoleIds={ids}
        empty={
          <div className="empty small">
            <div>Wire this orchestrator to teams or consoles to command them together.</div>
            <button className="btn sm primary" onPointerDown={(e) => e.stopPropagation()} onClick={() => startConnect(node.id)}>
              <Spline size={12} /> Connect
            </button>
          </div>
        }
      />
    </div>
  )
}
