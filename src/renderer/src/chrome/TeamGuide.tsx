import { useState } from 'react'
import { useApp } from '../state/store'
import { useInbox } from '../fleet/inboxModel'
import { useFleet } from '../engine/fleet'
import { offerGoal } from './goalIdeas'

/** An optional, persistent guide follows the actual team, rather than a tour of every feature. */
export function TeamGuide() {
  const dismissed = useApp((s) => s.project?.extras?.teamGuideDismissed)
  const fleet = useFleet((s) => s.state)
  const focused = useApp((s) => s.focusedNode)
  const [expanded, setExpanded] = useState(true)
  if (dismissed || focused) return null
  const active = Object.values(fleet?.members ?? {}).some((m) => m.role === 'lead' && m.status !== 'closed')
  const ready = !!fleet?.ready
  const app = useApp.getState()
  return <aside className="team-guide" aria-label="Your first team">
    <div className="row"><button className="btn ghost sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Your first team {expanded ? '−' : '+'}</button><span className="spacer" /><button className="btn ghost sm" onClick={() => app.setProjectExtra('teamGuideDismissed', true)}>Dismiss</button></div>
    {expanded && <>
      <ol>
        <li aria-current={!active ? 'step' : undefined}><b>Give it one small goal.</b> Review the scope and completion check before starting.</li>
        <li aria-current={active && !ready ? 'step' : undefined}><b>Follow progress.</b> Open the mission map; answer blockers in the Inbox (Ctrl+I).</li>
        <li aria-current={ready ? 'step' : undefined}><b>Review and merge.</b> Inspect the diff and Fleetboard’s observed check before accepting the result.</li>
      </ol>
      <button className="btn sm" onClick={() => ready ? useInbox.setState({ open: true, folded: false }) : active ? app.openPanel('missionMap') : offerGoal('Find and fix one small bug, add a regression test, and show me the diff.')}>
        {ready ? 'Open Inbox' : active ? 'See team progress' : 'Draft a first goal'}
      </button>
    </>}
  </aside>
}
