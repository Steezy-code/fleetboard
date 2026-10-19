import { activeWs, useApp } from '../state/store'

/** Enter wire mode from an orchestrator node: the next click on a team / console wires it. */
export function startConnect(orchestratorId: string) {
  useApp.setState({ tool: 'connector', wireFrom: orchestratorId })
  useApp.getState().toast('Click a team or console to wire it to the orchestrator')
}

/** Orchestrator node in the active workspace, created left of everything when there is none. */
export function ensureOrchestratorNode(): string | null {
  const ws = activeWs()
  if (!ws) return null
  const existing = ws.nodes.find((n) => n.type === 'orchestrator')
  if (existing) return existing.id
  const boxes = [...ws.nodes, ...ws.groups]
  const at = boxes.length
    ? { x: Math.min(...boxes.map((b) => b.x)) - 420, y: Math.min(...boxes.map((b) => b.y)) }
    : undefined
  return useApp.getState().addNode({ type: 'orchestrator', w: 340, h: 420, ...at, data: {} })
}
