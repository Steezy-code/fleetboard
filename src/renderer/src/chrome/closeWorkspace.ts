import { request } from '../lib/api'
import { useApp } from '../state/store'

// Closing a workspace tab. It used to delete the workspace at once whenever none of its consoles was
// running: notes, kanban cards, drawings and groups gone on one small ×, with no question and no way
// back. Running consoles are still asked about (closing them ends their sessions); everything else
// is closed straight away with an Undo on the toast, which puts the workspace back where it was.

export async function closeWorkspaceAsking(id: string): Promise<void> {
  const app = useApp.getState()
  const project = app.project
  const index = project?.workspaces.findIndex((w) => w.id === id) ?? -1
  const ws = project?.workspaces[index]
  if (!project || !ws) return
  const consoles = ws.nodes.filter((n) => n.type === 'console' && app.live[n.id])
  if (
    consoles.length &&
    !(await app.confirm({
      title: `Close ${ws.name}?`,
      body: consoles.length === 1 ? 'Its running console is closed with it.' : `Its ${consoles.length} running consoles are closed with it.`,
      confirm: 'Close workspace',
      danger: true
    }))
  )
    return
  for (const c of consoles) request('pty:kill', c.id)
  app.closeWorkspace(id)
  if (!ws.nodes.length && !ws.ink.length && !ws.groups.length) return
  const projectId = project.id
  app.toast(`Closed ${ws.name}.`, 'info', {
    label: 'Undo',
    run: () => {
      if (useApp.getState().project?.id !== projectId) return
      // a console comes back offering to resume its conversation, never as a new session
      const back = { ...ws, nodes: ws.nodes.map((n) => (n.type === 'console' ? { ...n, data: { ...n.data, launch: 'ask' } } : n)) }
      useApp.getState().restoreWorkspace(back, index)
    }
  })
}
