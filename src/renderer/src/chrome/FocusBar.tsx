import { ChevronLeft, ChevronRight, Undo2 } from 'lucide-react'
import { useApp } from '../state/store'
import { NODE_DEFS } from '../nodes/registry'
import { agentColor, agentLabel } from '../engine/consoles'

/** Pill shown in focus mode: what you're looking at, hop between consoles, and the way back. */
export function FocusBar() {
  const id = useApp((s) => s.focusedNode)
  const ws = useApp((s) => s.project?.workspaces.find((w) => w.id === s.project?.activeWorkspaceId))
  if (!id || !ws) return null
  const node = ws.nodes.find((n) => n.id === id)
  if (!node) return null
  const app = useApp.getState()
  const isConsole = node.type === 'console'
  const consoles = ws.nodes.filter((n) => n.type === 'console').sort((a, b) => a.y - b.y || a.x - b.x)
  const index = consoles.findIndex((n) => n.id === id)
  const name = isConsole ? node.data.name : node.title ?? NODE_DEFS[node.type]?.label ?? 'Tile'
  return (
    <div className="focus-bar" onPointerDown={(e) => e.stopPropagation()}>
      {isConsole && consoles.length > 1 && (
        <button className="icon-btn sm" title="Previous console (Ctrl+Shift+←)" onClick={() => app.cycleFocus(-1)}>
          <ChevronLeft size={15} />
        </button>
      )}
      {isConsole && <span className="agent-dot" style={{ background: agentColor(node.data.agentId) }} />}
      <b>{name}</b>
      {isConsole && <span className="muted">{agentLabel(node.data.agentId)}</span>}
      {isConsole && consoles.length > 1 && (
        <span className="dim">
          {index + 1} of {consoles.length}
        </span>
      )}
      {isConsole && consoles.length > 1 && (
        <button className="icon-btn sm" title="Next console (Ctrl+Shift+→)" onClick={() => app.cycleFocus(1)}>
          <ChevronRight size={15} />
        </button>
      )}
      <button className="btn sm" title="Ctrl+Shift+F, Esc, or Ctrl+scroll out" onClick={() => app.exitFocus()}>
        <Undo2 size={13} /> Back to board
      </button>
    </div>
  )
}
