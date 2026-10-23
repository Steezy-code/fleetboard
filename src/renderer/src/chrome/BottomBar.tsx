import { Lightbulb, Map as MapIcon, Minus, Plus, Scan } from 'lucide-react'
import { useHelm } from '../voice/helm/helm'
import { CAN_PAUSE } from '../lib/api'
import { zoomToSelection } from '../board/Board'
import { useApp, activeWs } from '../state/store'
import { consoleNodes, pauseAll, resumeAll, spawnConsoles } from '../engine/consoles'
import { CommandBar } from '../voice/CommandBar'
import { BranchBadge } from './BranchBadge'
import { CiBadge } from './CiBadge'
import { InboxTray } from '../fleet/InboxTray'
import { AmbientLine } from '../fleet/AmbientLine'
import { offerGoal, useGoalIdeas } from './goalIdeas'
import { useInbox } from '../fleet/inboxModel'

/** Group the selected consoles into a new team (or open the composer when nothing is selected). */
export function groupSelection() {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws) return
  const sel = ws.nodes.filter((n) => app.selection.includes(n.id) && n.type === 'console')
  if (!sel.length) return app.openPanel('composer')
  const pad = 24
  const x = Math.min(...sel.map((n) => n.x)) - pad
  const y = Math.min(...sel.map((n) => n.y)) - pad - 34
  const id = app.addGroup({ name: `Group ${ws.groups.length + 1}`, role: 'General', x, y, w: 10, h: 10 })
  sel.forEach((n) => app.updateNode(n.id, { groupId: id }))
  app.fitGroup(id)
  app.setSelection([id])
}

export function BottomBar() {
  const app = useApp.getState()
  const hint = useApp((s) => s.project?.extras.hintDismissed)
  const tray = useInbox((s) => s.items.length > 0)
  const idea = useGoalIdeas()[0]
  return (
    <div className={`bottombar ${tray ? 'with-tray' : ''}`}>
      {!hint && !tray && (
        <div className="try-hint">
          Try{' '}
          <button className="try-idea" title="Put it in the bar" onClick={() => offerGoal(idea?.text ?? 'add tests for the parser')}>
            "{idea?.text ?? 'add tests for the parser'}"
          </button>{' '}
          · your team plans it
          <button className="ws-x" onClick={() => app.setProjectExtra('hintDismissed', true)}>
            ×
          </button>
        </div>
      )}
      <div className="chip-row" style={tray ? { display: 'none' } : undefined}>
        <button
          className="chip"
          title="A panel of three agents brainstorms a topic; Oracle ranks the ideas"
          onClick={() => useHelm.setState((s) => ({ draft: { text: 'brainstorm ', n: (s.draft?.n ?? 0) + 1 } }))}
        >
          <Lightbulb size={12} /> Brainstorm
        </button>
        <button className="chip" onClick={() => app.openPanel('spawn')}>
          New console
        </button>
        <button
          className="chip"
          onClick={() => {
            const ids = spawnConsoles({ count: 4 })
            if (ids.length) setTimeout(() => useApp.getState().fitAll(), 50)
          }}
        >
          Spawn 4
        </button>
        <button className="chip" onClick={groupSelection}>
          Group
        </button>
        <button className="chip" onClick={() => app.openPanel('presets')}>
          Presets
        </button>
        {CAN_PAUSE && (
          <>
            <button className="chip" onClick={() => pauseAll()} disabled={!consoleNodes().length}>
              Pause all
            </button>
            <button className="chip" onClick={() => resumeAll()}>
              Resume all
            </button>
          </>
        )}
        <button className="chip" onClick={() => app.openPanel('memory')}>
          Memory
        </button>
      </div>
      <div className="bar-stack">
        <AmbientLine />
        <InboxTray />
        <CommandBar />
      </div>
    </div>
  )
}

export function ZoomControl() {
  const zoom = useApp((s) => s.project?.workspaces.find((w) => w.id === s.project?.activeWorkspaceId)?.camera.zoom ?? 1)
  const showMap = useApp((s) => s.settings.showMinimap)
  const app = useApp.getState()
  return (
    <div className="zoom-control">
      <button className="icon-btn sm" title="Zoom out" onClick={() => app.zoomAt(1 / 1.25)}>
        <Minus size={13} />
      </button>
      <button
        className="zoom-val"
        onClick={() => (app.selection.length ? zoomToSelection() : app.zoomAt(1 / zoom))}
        title="100% (or zoom to the selection)"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn sm" title="Zoom in" onClick={() => app.zoomAt(1.25)}>
        <Plus size={13} />
      </button>
      <button className="icon-btn sm" title="Zoom extents (Z E · Home · double-middle-click)" onClick={() => app.fitAll()}>
        <Scan size={13} />
      </button>
      <button
        className={`icon-btn sm ${showMap ? 'on' : ''}`}
        title="Minimap"
        onClick={() => app.setSettings({ showMinimap: !showMap })}
      >
        <MapIcon size={13} />
      </button>
    </div>
  )
}

export function BottomLeft() {
  return (
    <div className="bottom-left">
      <BranchBadge />
      <CiBadge />
    </div>
  )
}
