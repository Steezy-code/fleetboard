// Helm's view of the board: a compact plain-text snapshot of the open project (git, workspaces,
// every console with a short output tail, the team, board content, installed agents) that fits in
// one headless prompt. Console tails share whatever room is left after the rest.
import type { BoardNode, ConsoleStatus, Workspace } from '@shared/types'
import { agentById } from '@shared/agents'
import { invoke, relPath } from '../../lib/api'
import { activeWs, allConsoles, useApp } from '../../state/store'
import { consoleTail, isLive } from '../../engine/consoles'
import { activeLead, useFleet } from '../../engine/fleet'
import { PLAYBOOKS } from '../../playbooks/catalog'
import { currentConsole, nameOf, selectedConsoles } from '../actions'
import { useThread } from '../thread'

const MAX_CHARS = 12000
const TAIL_CHARS = 500
const BOARD_CHARS = 3000

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Terminal tail → readable text: no box drawing, spinners or blank runs. */
function cleanTail(raw: string, n: number) {
  const lines = raw
    .replace(/[─-▟⠀-⣿]+/g, ' ') // box drawing, blocks, braille spinners
    .replace(/[⏺⎿✻✶✳✢·•●○◯◉◐◓◑◒❯›»]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 1)
  const text = lines.join(' ⏎ ')
  return text.length > n ? '…' + text.slice(text.length - n + 1) : text
}

const statusOf = (id: string): ConsoleStatus => useApp.getState().statuses[id] ?? (isLive(id) ? 'idle' : 'exited')

const STATUS_ORDER: Record<string, number> = { 'needs-you': 0, working: 1, starting: 2, idle: 3, done: 4, paused: 5, exited: 6 }

async function gitLine(path: string): Promise<string> {
  try {
    const r = await Promise.race([
      invoke<any>('git:status', path),
      new Promise<null>((res) => window.setTimeout(() => res(null), 2500))
    ])
    if (!r) return 'git: (status timed out)'
    if (!r.ok) return `git: ${r.error ?? 'not a repository'}`
    const s = r.status
    const files: any[] = s.files ?? []
    const sync = [s.ahead ? `${s.ahead} ahead` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean).join(', ')
    const sample = files.slice(0, 6).map((f) => `${f.code} ${f.path}`).join(', ')
    return `git: branch ${s.detached ? '(detached)' : s.branch}${s.upstream ? ` → ${s.upstream}` : ''}${sync ? ` (${sync})` : ''}; ${files.length} changed file${files.length === 1 ? '' : 's'}${sample ? `: ${sample}${files.length > 6 ? ', …' : ''}` : ''}`
  } catch {
    return 'git: unavailable'
  }
}

function nodeLine(n: BoardNode, ws: Workspace, root: string): string | null {
  const d = n.data ?? {}
  switch (n.type) {
    case 'kanban': {
      const cols: any[] = d.columns ?? []
      const body = cols
        .map((c) => {
          const cards: any[] = c.cards ?? []
          const shown = cards.slice(0, 8).map((k) => clip(String(k.title ?? ''), 60) + (k.priority && k.priority !== 'none' ? ` (${k.priority})` : '') + (k.due ? ` due ${k.due}` : ''))
          return `${c.title} (${cards.length})${shown.length ? `: ${shown.join('; ')}${cards.length > 8 ? '; …' : ''}` : ''}`
        })
        .join(' | ')
      return `kanban "${n.title ?? 'Board'}": ${body || 'empty'}`
    }
    case 'checklist': {
      const items: any[] = d.items ?? []
      const done = items.filter((i) => i.done).length
      const shown = items.slice(0, 12).map((i) => `[${i.done ? 'x' : ' '}] ${clip(String(i.text ?? ''), 60)}`)
      return `checklist "${d.title ?? 'Objectives'}" (${done}/${items.length} done): ${shown.join('; ')}${items.length > 12 ? '; …' : ''}`
    }
    case 'note':
      return d.text?.trim() ? `sticky note: ${clip(d.text, 220)}` : null
    case 'text':
      return d.text?.trim() ? `label: ${clip(d.text, 120)}` : null
    case 'doc': {
      const h1 = /^\s*#\s+(.+)$/m.exec(d.markdown ?? '')?.[1]
      const title = d.title || h1 || (d.path ? relPath(root, d.path) : '') || 'untitled'
      return `doc: ${clip(title, 90)}${d.path ? ` (${relPath(root, d.path)})` : ''}`
    }
    case 'web':
      return d.url ? `web tile: ${d.url}` : null
    case 'file':
      return d.path ? `file tile: ${relPath(root, d.path)}` : null
    case 'image':
      return d.path ? `image: ${relPath(root, d.path)}` : null
    case 'plan':
      return `team plan tile for lead ${nameOf(d.leadId)}`
    case 'orchestrator': {
      const to = ws.wires.filter((w) => w.from === n.id).map((w) => nameOf(w.to))
      return `orchestrator${to.length ? ` wired to ${to.join(', ')}` : ''}`
    }
    case 'calendar': {
      const today = new Date().toISOString().slice(0, 10)
      const evs: any[] = (d.events ?? []).filter((e: any) => e.date >= today).sort((a: any, b: any) => (a.date < b.date ? -1 : 1))
      return evs.length ? `calendar, next: ${evs.slice(0, 4).map((e) => `${e.date}${e.time ? ' ' + e.time : ''} ${clip(e.title, 40)}`).join('; ')}` : null
    }
    case 'git':
      return 'git card'
    default:
      return null
  }
}

function boardSection(): string {
  const p = useApp.getState().project!
  const out: string[] = []
  const ordered = [...p.workspaces].sort((a, b) => (a.id === p.activeWorkspaceId ? -1 : b.id === p.activeWorkspaceId ? 1 : 0))
  for (const ws of ordered) {
    const lines: string[] = []
    for (const g of ws.groups) {
      const members = ws.nodes.filter((n) => n.groupId === g.id).map((n) => (n.type === 'console' ? n.data?.name : n.type))
      lines.push(`group "${g.name}" (${g.role}): ${members.join(', ') || 'empty'}`)
    }
    for (const n of ws.nodes) {
      if (n.type === 'console') continue
      const l = nodeLine(n, ws, p.path)
      if (l) lines.push(l)
    }
    const labels = ws.ink.filter((i) => i.kind === 'label' && i.text?.trim()).map((i) => clip(i.text!, 60))
    if (labels.length) lines.push(`drawn labels: ${labels.slice(0, 10).join('; ')}`)
    if (lines.length) out.push(`[${ws.name}]\n` + lines.map((l) => `- ${l}`).join('\n'))
  }
  const text = out.join('\n')
  return text.length > BOARD_CHARS ? text.slice(0, BOARD_CHARS - 1) + '…' : text
}

function fleetSection(): string {
  const s = useFleet.getState().state
  if (!s) return 'none'
  const members = Object.values(s.members).filter((m) => m.status !== 'closed')
  const name = (id?: string) => (!id ? '' : id === 'user' ? 'you' : (s.members[id]?.name ?? nameOf(id)))
  const lines: string[] = []
  const lead = activeLead()
  if (lead) {
    const goal = lead.task ?? s.messages.find((m) => m.to === lead.id && m.kind === 'goal')?.text ?? ''
    lines.push(`active lead: ${lead.name}${lead.branch ? ` on ${lead.branch}` : ''} · goal: ${clip(goal, 400)}`)
  } else lines.push('active lead: none (a new goal starts one)')
  if (s.tasks.length) lines.push('plan:\n' + s.tasks.map((t, i) => `  ${i + 1}. [${t.status}] ${clip(t.title, 90)}${t.owner ? ` (${name(t.owner)})` : ''}${t.note ? ` · ${clip(t.note, 60)}` : ''}`).join('\n'))
  if (members.length)
    lines.push(
      'members: ' +
        members.map((m) => `${m.name} (${m.role}, ${m.status}${m.leadId ? `, under ${name(m.leadId)}` : ''}${m.task && m.role !== 'lead' ? `: ${clip(m.task, 80)}` : ''})`).join('; ')
    )
  const open = s.asks.filter((a) => !a.answer)
  if (open.length) lines.push('unanswered questions for the user: ' + open.map((a) => `${name(a.from)} asks "${clip(a.question, 140)}"${a.options.length ? ` [${a.options.join(' / ')}]` : ''}`).join('; '))
  if (s.ready) lines.push(`ready for review: branch ${s.ready.branch}, ${s.ready.commits} commit(s), ${s.ready.files.length} file(s): ${clip(s.ready.summary, 260)}`)
  return lines.join('\n')
}

function agentsSection(): string {
  const app = useApp.getState()
  const custom = app.settings.customAgents
  const list = app.agents.filter((a) => a.path).map((a) => `${a.id}${agentById(a.id, custom)?.name && agentById(a.id, custom)!.name !== a.id ? ` (${agentById(a.id, custom)!.name})` : ''}`)
  for (const c of custom) if (!list.some((l) => l.startsWith(c.id))) list.push(`${c.id} (${c.name}, custom)`)
  return `${list.join(', ') || 'unknown (detection pending)'} · default ${app.settings.defaultAgent}`
}

export function playbookCatalog(): string {
  return PLAYBOOKS.map((pb) => {
    const inputs = pb.inputs.length
      ? pb.inputs.map((i) => `${i.key}${i.optional || i.kind === 'switch' ? '?' : ''}${i.value ? `="${i.value}"` : ''} (${i.label})`).join(', ')
      : 'none'
    return `- ${pb.id} · ${pb.name}${pb.panel ? ' [built-in, read-only]' : ''} · when: ${pb.whenToUse} · inputs: ${inputs}`
  }).join('\n')
}

function recentThread(): string {
  const entries = useThread.getState().entries.slice(-9, -1) // the current request is the last entry
  return entries.map((e) => `${e.kind === 'user' ? 'user' : e.kind}: ${clip(e.text, 160)}`).join('\n')
}

/** The whole snapshot, under ~12k characters. */
export async function boardContext(isCancelled: () => boolean = () => false): Promise<string> {
  const app = useApp.getState()
  const p = app.project
  if (!p) return ''
  const ws = activeWs()
  const consoles = allConsoles().sort((a, b) => (STATUS_ORDER[statusOf(a.id)] ?? 9) - (STATUS_ORDER[statusOf(b.id)] ?? 9))
  const [git, tails] = await Promise.all([
    gitLine(p.path),
    Promise.all(consoles.map((c) => (statusOf(c.id) === 'exited' || !isLive(c.id) ? Promise.resolve('') : consoleTail(c.id, 1600).catch(() => ''))))
  ])
  if (isCancelled()) return ''

  const fleet = useFleet.getState().state
  const sel = selectedConsoles().map(nameOf)
  const cur = currentConsole()
  const head = [
    `project: ${p.name} (${p.path})`,
    git,
    `workspaces: ${p.workspaces.map((w) => (w.id === ws?.id ? `${w.name} (active)` : w.name)).join(', ')}`,
    sel.length ? `selected: ${sel.join(', ')}` : cur ? `most recently active console: ${nameOf(cur)}` : '',
    `installed agents: ${agentsSection()}`
  ]
    .filter(Boolean)
    .join('\n')

  const team = `TEAM\n${fleetSection()}`
  const board = boardSection()
  const boardText = board ? `BOARD CONTENT\n${board}` : 'BOARD CONTENT\n(nothing besides consoles)'
  const thread = recentThread()
  const threadText = thread ? `RECENT COMMAND THREAD\n${thread}` : ''

  const consoleHead = (c: (typeof consoles)[number]) => {
    const m = fleet?.members[c.id]
    const w = p.workspaces.find((x) => x.id === c.workspaceId)
    const group = c.groupId ? w?.groups.find((g) => g.id === c.groupId)?.name : undefined
    const bits = [
      c.data.agentId,
      statusOf(c.id),
      m ? `${m.role}${m.task && m.role !== 'lead' ? `: ${clip(m.task, 100)}` : ''}` : '',
      group ? `group ${group}` : '',
      p.workspaces.length > 1 ? `in ${w?.name}` : ''
    ].filter(Boolean)
    return `## ${c.data.name} (${bits.join(' · ')})`
  }
  const fixed = [head, team, boardText, threadText].filter(Boolean).join('\n\n')
  const headers = consoles.map(consoleHead)
  const room = MAX_CHARS - fixed.length - headers.join('\n').length - 40
  const withTail = tails.filter(Boolean).length
  const per = withTail ? Math.min(TAIL_CHARS, Math.floor(room / withTail) - 20) : 0
  const consoleText = consoles.length
    ? consoles.map((c, i) => (tails[i] && per >= 80 ? `${headers[i]}\n${cleanTail(tails[i], per)}` : headers[i])).join('\n')
    : '(no consoles yet)'

  const all = `${head}\n\nCONSOLES (newest output last)\n${consoleText}\n\n${[team, boardText, threadText].filter(Boolean).join('\n\n')}`
  return all.length > MAX_CHARS ? all.slice(0, MAX_CHARS - 2) + '\n…' : all
}
