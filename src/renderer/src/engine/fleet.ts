import { create } from 'zustand'
import { mapWorkspaces, type BoardNode, type ConsoleData } from '@shared/types'
import type { FleetMember, FleetState } from '@shared/fleet'
import { invoke, on } from '../lib/api'
import { activeWs, allConsoles, useApp } from '../state/store'
import { CONSOLE_H, CONSOLE_W } from './consoles'

// Board side of lead/worker teams: mirrors the fleet state from the main process, places team
// consoles on the board, and routes the user's goals to the lead.

interface FleetUi {
  state: FleetState | null
  /** wire endpoints that just carried a message, for the pulse animation */
  hot: Record<string, number>
}

export const useFleet = create<FleetUi>(() => ({ state: null, hot: {} }))

export const memberOf = (id: string): FleetMember | undefined => useFleet.getState().state?.members[id]

export function activeLead(): FleetMember | undefined {
  const s = useFleet.getState().state
  const live = useApp.getState().live
  return Object.values(s?.members ?? {})
    .filter((m) => m.role === 'lead' && m.status !== 'closed' && live[m.id])
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * Before a team starts in a folder it cannot keep apart from the user's files (not a repository, or
 * one without a commit: no worktrees), say so and ask.
 */
export async function confirmTeamFolder(projectPath: string): Promise<boolean> {
  const kind = await invoke<'worktrees' | 'no-commits' | 'no-repo'>('fleet:isolation', projectPath).catch(() => 'worktrees' as const)
  if (kind === 'worktrees') return true
  return useApp.getState().confirm({
    title: 'Let the team work in your files directly?',
    body:
      (kind === 'no-repo' ? 'This folder is not a git repository' : 'This repository has no commits yet') +
      ', so the team cannot work in copies of its own: the Lead and its workers edit the files here, side by side, and nothing waits for you to review or merge. To keep your files apart from the team, make a first commit (Git drawer), then start it.',
    confirm: 'Start anyway',
    danger: true
  })
}

/** Give work to the team: message the current lead, or start one. */
export async function sendGoal(goal: string) {
  const app = useApp.getState()
  const p = app.project
  if (!p) return
  const lead = activeLead()
  if (lead) {
    await invoke('fleet:userMessage', lead.id, goal)
    app.toast(`Sent to ${lead.name}`, 'ok')
    return lead
  }
  if (!(await confirmTeamFolder(p.path))) return
  app.toast('Starting a Lead for this goal…')
  const m = await invoke<FleetMember>('fleet:startLead', { projectId: p.id, projectPath: p.path, goal })
  return m
}

/** Find the workspace holding a node (team consoles may live in a background workspace). */
function workspaceOf(nodeId: string) {
  const p = useApp.getState().project
  return p?.workspaces.find((w) => w.nodes.some((n) => n.id === nodeId))
}

/** Add a node to a specific workspace without switching to it. */
function addNodeTo(wsId: string, node: BoardNode) {
  const p = useApp.getState().project
  if (!p) return
  const workspaces = mapWorkspaces(p, (w) => {
    if (w.id !== wsId) return w
    const z = w.nodes.reduce((m, n) => Math.max(m, n.z), 0) + 1
    return { ...w, nodes: [...w.nodes, { ...node, z }] }
  })
  useApp.setState({ project: { ...p, workspaces } })
  useApp.getState().setProjectExtra('fleetTouched', Date.now()) // persists the project
}

function addWireTo(wsId: string, from: string, to: string) {
  const p = useApp.getState().project
  if (!p) return
  const workspaces = mapWorkspaces(p, (w) =>
    w.id !== wsId || w.wires.some((x) => x.from === from && x.to === to) ? w : { ...w, wires: [...w.wires, { id: `wire${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, from, to }] }
  )
  useApp.setState({ project: { ...p, workspaces } })
}

function removeEverywhere(ids: string[]) {
  const p = useApp.getState().project
  if (!p) return
  const set = new Set(ids)
  const workspaces = mapWorkspaces(p, (w) => ({
    ...w,
    nodes: w.nodes.filter((n) => !set.has(n.id) && !(n.type === 'plan' && set.has(n.data?.leadId))),
    wires: w.wires.filter((x) => !set.has(x.from) && !set.has(x.to))
  }))
  useApp.setState({ project: { ...p, workspaces } })
  useApp.getState().setProjectExtra('fleetTouched', Date.now())
}

/** Where a new team console goes: leads in free space, workers in a row under their lead. */
function placeFor(m: FleetMember): { wsId: string; x: number; y: number } {
  const app = useApp.getState()
  const p = app.project!
  if (m.leadId) {
    const ws = workspaceOf(m.leadId) ?? activeWs()!
    const lead = ws.nodes.find((n) => n.id === m.leadId)
    if (lead) {
      const mates = ws.nodes.filter((n) => n.type === 'console' && memberOf(n.id)?.leadId === m.leadId)
      const i = mates.length
      // up to four slots centred under the lead, then a second row
      const col = i % 4
      const row = Math.floor(i / 4)
      return { wsId: ws.id, x: lead.x + lead.w / 2 - 2 * (CONSOLE_W + 24) + 12 + col * (CONSOLE_W + 24), y: lead.y + lead.h + 140 + row * (CONSOLE_H + 40) }
    }
  }
  const ws = activeWs() ?? p.workspaces[0]
  const boxes = [...ws.nodes, ...ws.groups]
  if (!boxes.length) {
    const vp = app.viewport
    const cam = ws.camera
    return { wsId: ws.id, x: (vp.w / 2 - cam.x) / cam.zoom - CONSOLE_W / 2, y: (vp.h / 3 - cam.y) / cam.zoom - CONSOLE_H / 2 }
  }
  return { wsId: ws.id, x: Math.max(...boxes.map((b) => b.x + b.w)) + 160, y: Math.min(...boxes.map((b) => b.y)) }
}

function nameFree(wanted: string) {
  const taken = new Set(allConsoles().map((c) => (c.data.name as string).toLowerCase()))
  if (!taken.has(wanted.toLowerCase())) return wanted
  for (let i = 2; i < 50; i++) if (!taken.has(`${wanted} ${i}`.toLowerCase())) return `${wanted} ${i}`
  return wanted
}

let wired = false
export function wireFleet() {
  if (wired) return
  wired = true

  const refresh = async () => {
    const p = useApp.getState().project
    useFleet.setState({ state: p ? await invoke<FleetState>('fleet:state', p.id, p.path) : null })
  }
  useApp.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) refresh()
  })
  refresh()

  on('fleet:state', (s: FleetState) => {
    if (s.projectId === useApp.getState().project?.id) useFleet.setState({ state: s })
  })

  on('fleet:addConsole', ({ reqId, member }: { reqId: string; member: FleetMember }) => {
    const app = useApp.getState()
    if (!app.project || app.project.id !== member.projectId) return invoke('fleet:ack', reqId, {})
    const name = nameFree(member.name)
    const { wsId, x, y } = placeFor(member)
    const data: ConsoleData & Record<string, any> = {
      agentId: member.agentId,
      name,
      cwd: member.cwd,
      launch: 'fresh',
      createdAt: Date.now(),
      fleetRole: member.role
    }
    const lead = member.role === 'lead'
    addNodeTo(wsId, { id: member.id, type: 'console', x, y, w: lead ? CONSOLE_W + 60 : CONSOLE_W, h: lead ? CONSOLE_H + 40 : CONSOLE_H, z: 0, data })
    if (member.leadId) addWireTo(wsId, member.leadId, member.id)
    if (lead && wsId === activeWs()?.id) setTimeout(() => useApp.getState().focusItem(member.id), 120)
    invoke('fleet:ack', reqId, { name })
  })

  on('fleet:removeConsoles', (ids: string[]) => removeEverywhere(ids))

  // Show the lead's plan next to it the first time it makes one.
  on('fleet:plan', ({ leadId }: { leadId: string }) => {
    const ws = workspaceOf(leadId)
    if (!ws || ws.nodes.some((n) => n.type === 'plan' && n.data?.leadId === leadId)) return
    const lead = ws.nodes.find((n) => n.id === leadId)!
    addNodeTo(ws.id, { id: `plan${leadId}`, type: 'plan', x: lead.x - 360, y: lead.y, w: 320, h: Math.max(260, lead.h), z: 0, data: { leadId } })
  })

  on('fleet:traffic', ({ from, to }: { from: string; to: string }) => {
    const until = Date.now() + 1800
    useFleet.setState((s) => ({ hot: { ...s.hot, [`${from}>${to}`]: until, [`${to}>${from}`]: until } }))
    setTimeout(() => useFleet.setState((s) => ({ hot: Object.fromEntries(Object.entries(s.hot).filter(([, t]) => t > Date.now())) })), 1900)
  })

  on('fleet:asked', () => useApp.getState().toast('Your lead has a question', 'info'))
  on('fleet:ready', () => useApp.getState().toast('Your team finished. Review it in the Inbox.', 'ok'))
  // something put a member's work at risk (a commit that failed, a worktree kept back). The lead is
  // a model, so a note in its chat reaches nobody who can act on it.
  on('fleet:trouble', ({ message, tone }: { message: string; tone: 'warn' | 'info' }) => useApp.getState().toast(message, tone))
}

/** Is this text an instruction about the board itself rather than work for the team? */
export function looksLikeBoardCommand(text: string) {
  const t = text.toLowerCase().trim()
  return (
    /^(spawn|start|launch|open|close|kill|pause|resume|stop|group|ungroup|wire|connect|zoom|fit|show me|go to|focus|frame|new workspace|switch|delete|remove|rename|move|arrange|tidy)\b/.test(t) ||
    /\b(console|consoles|workspace|mission map|minimap|the board|panel|drawer)\b/.test(t)
  )
}
