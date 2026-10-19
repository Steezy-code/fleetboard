import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { BoardNode, ConsoleData, ConsoleStatus, Group, Project, Wire } from '@shared/types'
import { useApp } from '../state/store'

// Fleet model shared by the mission map, the orchestrator and loops: every console / team /
// orchestrator across all workspaces of the open project.

export type Bucket = 'working' | 'needs-you' | 'idle' | 'done'

export interface FleetConsole {
  id: string
  name: string
  agentId: string
  workspaceId: string
  workspaceName: string
  groupId?: string
  createdAt: number
  node: BoardNode<ConsoleData>
}

export interface FleetTeam extends Group {
  workspaceId: string
  workspaceName: string
  memberIds: string[]
}

export interface FleetOrchestrator {
  id: string
  title: string
  workspaceId: string
  workspaceName: string
  /** team ids and console ids wired to it */
  wiredIds: string[]
}

export interface Fleet {
  consoles: FleetConsole[]
  teams: FleetTeam[]
  orchestrators: FleetOrchestrator[]
  wires: (Wire & { workspaceId: string })[]
  multiWs: boolean
}

export function buildFleet(p: Project | null): Fleet {
  if (!p) return { consoles: [], teams: [], orchestrators: [], wires: [], multiWs: false }
  const consoles: FleetConsole[] = []
  const teams: FleetTeam[] = []
  const orchestrators: FleetOrchestrator[] = []
  const wires: Fleet['wires'] = []
  for (const ws of p.workspaces) {
    const wsConsoles = ws.nodes.filter((n) => n.type === 'console') as BoardNode<ConsoleData>[]
    for (const n of wsConsoles) {
      consoles.push({
        id: n.id,
        name: n.data.name,
        agentId: n.data.agentId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        groupId: n.groupId,
        createdAt: n.data.createdAt,
        node: n
      })
    }
    for (const g of ws.groups) {
      teams.push({ ...g, workspaceId: ws.id, workspaceName: ws.name, memberIds: wsConsoles.filter((n) => n.groupId === g.id).map((n) => n.id) })
    }
    for (const w of ws.wires) wires.push({ ...w, workspaceId: ws.id })
    for (const n of ws.nodes.filter((x) => x.type === 'orchestrator')) {
      const wiredIds = ws.wires.flatMap((w) => (w.from === n.id ? [w.to] : w.to === n.id ? [w.from] : []))
      orchestrators.push({ id: n.id, title: n.title ?? 'Orchestrator', workspaceId: ws.id, workspaceName: ws.name, wiredIds })
    }
  }
  return { consoles, teams, orchestrators, wires, multiWs: p.workspaces.length > 1 }
}

/** Reactive fleet; recomputed when nodes / groups / wires / workspace names change (not on camera moves). */
export function useFleet(): Fleet {
  const sig = useApp(
    useShallow((s) => (s.project ? [s.project.id, ...s.project.workspaces.flatMap((w) => [w.id, w.name, w.nodes, w.groups, w.wires])] : []))
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildFleet(useApp.getState().project), [sig])
}

/** Effective status of a console (unknown + live = idle, unknown + not live = exited). */
export const statusOf = (statuses: Record<string, ConsoleStatus>, live: Record<string, boolean>, id: string): ConsoleStatus =>
  statuses[id] ?? (live[id] ? 'idle' : 'exited')

export const bucketOf = (s: ConsoleStatus): Bucket =>
  s === 'working' ? 'working' : s === 'needs-you' ? 'needs-you' : s === 'done' || s === 'exited' ? 'done' : 'idle'

/** Statuses for a list of ids, as a stable array. */
export function useStatuses(ids: string[]): ConsoleStatus[] {
  return useApp(useShallow((s) => ids.map((id) => statusOf(s.statuses, s.live, id))))
}

export const STATUS_TEXT: Record<ConsoleStatus, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'resting',
  'needs-you': 'needs you',
  done: 'done',
  paused: 'paused',
  exited: 'stopped'
}

export const BUCKET_LABEL: Record<Bucket, string> = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle', done: 'Done' }

/** Installed agents (found on PATH), shell always available. */
export function useInstalledAgents(): string[] {
  return useApp(
    useShallow((s) => {
      const ids = s.agents.filter((a) => a.path).map((a) => a.id)
      if (!ids.includes('shell')) ids.push('shell')
      return ids
    })
  )
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Bring a console / team into view: switch workspace if needed, close the panel, focus it. */
export function goToItem(id: string, workspaceId?: string) {
  const app = useApp.getState()
  if (workspaceId && app.project && app.project.activeWorkspaceId !== workspaceId) app.switchWorkspace(workspaceId)
  app.closePanel()
  window.setTimeout(() => useApp.getState().focusItem(id), 60)
}
