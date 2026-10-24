import type { BoardNode, ConsoleData, Role } from '@shared/types'
import { agentById } from '@shared/agents'
import { request, on } from '../lib/api'
import { activeWs, allConsoles, useApp } from '../state/store'
import { findFreeSpot, occupied, viewCentre } from '../board/place'
import { setActivity } from './activity'

// Console lifecycle shared by the board, the composer, the orchestrator, voice and loops.

export const CONSOLE_W = 780 // ~100 columns at the default font: CLIs like Claude Code need that to lay out cleanly
export const CONSOLE_H = 440
const GAP = 24

let wired = false
/** Subscribe once to status/exit events from the main process. */
export function wireConsoleEvents() {
  if (wired) return
  wired = true
  const app = useApp.getState
  on('pty:status', (id: string, status) => app().setStatus(id, status))
  on('pty:activity', (id: string, text: string | null) => setActivity(id, text))
  on('pty:exit', (id: string) => {
    setActivity(id, null)
    app().setLive(id, false)
    app().setStatus(id, 'exited')
  })
  // the conversation a console runs under: what reopening the board resumes
  on('pty:session', (id: string, sessionId: string) => {
    const next = sessionId || undefined
    if (allConsoles().find((c) => c.id === id)?.data.sessionId !== next) app().updateNodeData(id, { sessionId: next })
  })
  // something failed in the background (it is in ~/.fleetboard/logs/main.log); the app keeps running
  on('app:error', (message: string) => app().toast(`Something went wrong in the background: ${message}`, 'warn'))
  // main saying something the user needs to know in their own words (a refused tile permission)
  on('app:notice', (message: string) => app().toast(message, 'warn'))
  on('pty:lostSession', (id: string) => {
    const name = allConsoles().find((c) => c.id === id)?.data.name ?? 'A console'
    app().toast(`${name}'s last conversation could not be resumed (its CLI no longer has it), so it started a new one.`, 'warn')
  })
  on('pty:held', (id: string) => {
    const name = allConsoles().find((c) => c.id === id)?.data.name ?? 'That console'
    app().toast(`${name} is asking something, so your message waits until it's answered (see the Inbox).`, 'warn')
  })
}

export const consoleNodes = (): BoardNode<ConsoleData>[] => (activeWs()?.nodes.filter((n) => n.type === 'console') ?? []) as BoardNode<ConsoleData>[]

/** Next free name like "Maya", then "Maya 2" once the base names run out. */
export function nextName(taken = allConsoles().map((n) => n.data.name as string)): string {
  const names = useApp.getState().settings.names
  const used = new Set(taken)
  for (let round = 1; round < 50; round++) {
    for (const n of names) {
      const name = round === 1 ? n : `${n} ${round}`
      if (!used.has(name)) return name
    }
  }
  return `Agent ${used.size + 1}`
}

/** Where a block of new consoles goes: as near the middle of the view as it fits without covering anything. */
function freeOrigin(size: { w: number; h: number }): { x: number; y: number } {
  const ws = activeWs()
  const cam = ws?.camera ?? { x: 0, y: 0, zoom: 1 }
  const near = viewCentre(useApp.getState().viewport, cam, size)
  return ws ? findFreeSpot(occupied(ws), size, near) : near
}

export interface SpawnOptions {
  agentId?: string
  count?: number
  /** one agent per slot (composer) */
  agents?: string[]
  names?: string[]
  group?: { name: string; role: Role } | string
  autoApprove?: boolean
  acceptEdits?: boolean
  profileId?: string
  /** first message typed into each new console once it is ready */
  initialPrompt?: string
  cols?: number
  at?: { x: number; y: number }
}

/** Create console nodes on the board (they start their PTY when mounted). Returns node ids. */
export function spawnConsoles(opts: SpawnOptions = {}): string[] {
  const app = useApp.getState()
  const project = app.project
  if (!project) return []
  const agents = opts.agents ?? Array.from({ length: opts.count ?? 1 }, () => opts.agentId ?? app.settings.defaultAgent)
  const n = agents.length
  const cols = opts.cols ?? Math.min(4, Math.ceil(Math.sqrt(n)))
  const rows = Math.ceil(n / cols)
  const origin =
    opts.at ?? freeOrigin({ w: 48 + cols * CONSOLE_W + (cols - 1) * GAP, h: (opts.group ? 58 + 24 : 0) + rows * CONSOLE_H + (rows - 1) * GAP })

  let groupId: string | undefined
  const headerOffset = opts.group ? 58 : 0
  if (typeof opts.group === 'string') groupId = opts.group
  else if (opts.group) {
    groupId = app.addGroup({ name: opts.group.name, role: opts.group.role, x: origin.x, y: origin.y, w: 100, h: 100 })
  }

  const taken = allConsoles().map((c) => c.data.name as string)
  const ids: string[] = []
  agents.forEach((agentId, i) => {
    const name = opts.names?.[i] ?? nextName(taken)
    taken.push(name)
    const col = i % cols
    const row = Math.floor(i / cols)
    const data: ConsoleData = {
      agentId,
      name,
      cwd: project.path,
      autoApprove: opts.autoApprove,
      acceptEdits: opts.acceptEdits,
      profileId: opts.profileId,
      launch: 'fresh',
      createdAt: Date.now()
    }
    const id = app.addNode({
      type: 'console',
      x: origin.x + 24 + col * (CONSOLE_W + GAP),
      y: origin.y + headerOffset + row * (CONSOLE_H + GAP),
      w: CONSOLE_W,
      h: CONSOLE_H,
      groupId,
      data: { ...data, pendingPrompt: opts.initialPrompt }
    })
    ids.push(id)
  })
  if (groupId) useApp.getState().fitGroup(groupId)
  return ids
}

/** Build the PTY spawn request for a console node and start it. */
export async function startConsole(node: BoardNode<ConsoleData>, cols: number, rows: number, resume = false) {
  const app = useApp.getState()
  const info = await request('pty:spawn', {
    id: node.id,
    agentId: node.data.agentId,
    cwd: node.data.cwd,
    cols,
    rows,
    resume,
    sessionId: node.data.sessionId,
    autoApprove: node.data.autoApprove,
    acceptEdits: node.data.acceptEdits,
    profileId: node.data.profileId,
    extraArgs: node.data.extraArgs,
    command: node.data.command
  })
  app.setLive(node.id, true, info.autoApproves)
  app.setStatus(node.id, info.status)
  return info
}

/**
 * Type text into a console as one bracketed paste; with submit, Enter follows once the paste has
 * landed, so the CLI submits it instead of treating the Enter as part of the paste.
 */
export function sendToConsole(id: string, text: string, submit = true) {
  window.fb.send('pty:paste', id, text.trim(), submit)
}

export const isLive = (id: string) => !!useApp.getState().live[id]

export async function killConsoles(ids: string[], { confirm = true, remove = true } = {}) {
  const app = useApp.getState()
  const liveIds = ids.filter(isLive)
  if (confirm && liveIds.length && app.settings.confirmKill) {
    const names = liveIds.map((id) => allConsoles().find((c) => c.id === id)?.data.name ?? id)
    const ok = await app.confirm({
      title: liveIds.length === 1 ? `Close ${names[0]}?` : `Close ${liveIds.length} running agents?`,
      body: `${names.join(', ')} ${liveIds.length === 1 ? 'is' : 'are'} running. Closing ends ${liveIds.length === 1 ? 'its' : 'their'} session.`,
      confirm: 'Close',
      danger: true
    })
    if (!ok) return false
  }
  await Promise.all(liveIds.map((id) => request('pty:kill', id)))
  if (remove) app.removeNodes(ids)
  return true
}

export const pauseAll = (ids = consoleNodes().map((n) => n.id)) => Promise.all(ids.filter(isLive).map((id) => request('pty:pause', id)))
export const resumeAll = (ids = consoleNodes().map((n) => n.id)) => Promise.all(ids.filter(isLive).map((id) => request('pty:resume', id)))

/** Plain-text tail of a console's output. */
export const consoleTail = (id: string, chars = 8000) => request('pty:tail', id, chars)

export const agentLabel = (agentId: string) => agentById(agentId, useApp.getState().settings.customAgents)?.name ?? agentId
export const agentColor = (agentId: string) => agentById(agentId, useApp.getState().settings.customAgents)?.color ?? '#a8a29e'

/** Resolve a spoken / typed name ("maya", "Maya 2", "codex", "backend") to console ids. */
export function resolveTargets(word: string): string[] {
  const w = word.toLowerCase().replace(/^@/, '').trim()
  const consoles = allConsoles()
  const ws = activeWs()
  if (['all', 'everyone', 'everybody', 'all agents', 'all consoles', 'team'].includes(w)) return consoles.map((c) => c.id)
  const byName = consoles.filter((c) => c.data.name.toLowerCase() === w || c.data.name.toLowerCase().replace(/\s+/g, '') === w.replace(/\s+/g, ''))
  if (byName.length) return byName.map((c) => c.id)
  const group = ws?.groups.find((g) => g.name.toLowerCase() === w || g.role.toLowerCase() === w)
  if (group) return ws!.nodes.filter((n) => n.groupId === group.id && n.type === 'console').map((n) => n.id)
  const byAgent = consoles.filter((c) => c.data.agentId === w || agentLabel(c.data.agentId).toLowerCase() === w)
  return byAgent.map((c) => c.id)
}


// One listener for all PTY output, fanned out by console id.
const dataSubs = new Map<string, Set<(d: string) => void>>()
let dataWired = false
export function onConsoleData(id: string, cb: (d: string) => void) {
  if (!dataWired) {
    dataWired = true
    on('pty:data', (cid: string, d: string) => dataSubs.get(cid)?.forEach((f) => f(d)))
  }
  let set = dataSubs.get(id)
  if (!set) dataSubs.set(id, (set = new Set()))
  set.add(cb)
  return () => {
    set!.delete(cb)
  }
}
