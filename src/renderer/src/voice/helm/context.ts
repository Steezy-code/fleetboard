// Helm's view of the board: a compact plain-text snapshot of the open project (git, what is known
// about the repo, workspaces, every console with a short output tail, the team and the charter it
// works to, board content, installed agents, CI and pull requests, the last morning sweep of the
// user's other repos) that fits in one headless prompt. Console tails share whatever room is left
// after the rest.
//
// With a board selection the snapshot is only what was pointed at: the selected consoles (with the
// room the others would have had), the selected tiles, and the charter when a selected console is on
// the team. Asked "why is this stuck?" about two consoles and a card, Oracle sees those three things.
// What is known about the repo stays in either way: it is small, and it is what a charter cites.
import type { BoardNode, ConsoleStatus, Workspace } from '@shared/types'
import type { FleetMember, FleetState } from '@shared/fleet'
import { agentById } from '@shared/agents'
import { checkTrend, diffLabel, elapsedLabel, minutes, span } from '@shared/live'
import { activityOf } from '../../engine/activity'
import { knowledgeBlock } from '@shared/knowledge'
import { refreshKnowledge } from '../../fleet/knowledge'
import { invoke } from '../../lib/api'
import { relativeTo } from '../../workbench/paths'
import { activeWs, allConsoles, useApp } from '../../state/store'
import { consoleTail, isLive } from '../../engine/consoles'
import { activeLead, useFleet } from '../../engine/fleet'
import { PLAYBOOKS } from '../../playbooks/catalog'
import { currentConsole, nameOf, selectedConsoles } from '../actions'
import { useThread } from '../thread'
import { useCi } from '../../workbench/ciStore'
import { agentMade, ownerOf, unsent, useFeedback } from '../../workbench/prFeedback'
import type { SweepResult } from '../../../../main/sweep'

const MAX_CHARS = 12000
const TAIL_CHARS = 500
/** a selected console's tail: the room the rest of the board would have used */
const SCOPED_TAIL_CHARS = 2500
const BOARD_CHARS = 3000
/** quieter than this, a member's line says so */
const QUIET_NOTE_MIN = 2
/** Standing facts are worth more than another console's tail, but not the whole snapshot. */
const KNOWN_CHARS = 2000

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
      const title = d.title || h1 || (d.path ? relativeTo(root, d.path) : '') || 'untitled'
      return `doc: ${clip(title, 90)}${d.path ? ` (${relativeTo(root, d.path)})` : ''}`
    }
    case 'web':
      return d.url ? `web tile: ${d.url}` : null
    case 'file':
      return d.path ? `file tile: ${relativeTo(root, d.path)}` : null
    case 'image':
      return d.path ? `image: ${relativeTo(root, d.path)}` : null
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

/**
 * What the job was agreed to be, and how the check is going: the charter is the user's, so Oracle
 * answers "is it nearly done?" against it rather than against its own reading of the consoles.
 *
 * ponytail: plan 2's project profile joins here as its own section once it exists — the standing facts
 * the charter's "known" assumptions cite. Until then the charter's citations are all there is.
 */
function charterLines(s: FleetState, lead: FleetMember | undefined): string[] {
  const c = s.charter
  if (!c) return []
  const lines = [`charter (what the user confirmed the job is): ${clip(c.understood, 300)}`]
  if (c.wontTouch.length) lines.push(`  won't touch: ${c.wontTouch.join(', ')}`)
  if (c.doneWhen) lines.push(`  done when: ${c.doneWhen} · ${checkTrend(s.check, c.doneWhen)}`)
  const job = lead ? elapsedLabel({ startedAt: lead.createdAt, endedAt: s.ready?.leadId === lead.id ? s.ready.at : undefined, estimate: c.estimate }, Date.now()) : ''
  if (job) lines.push(`  time: ${job}`)
  return lines
}

/** A member as Oracle reads it: role, status, task, and what the live work says about it. */
function memberLine(s: FleetState, m: FleetMember, name: (id?: string) => string): string {
  const now = Date.now()
  const quiet = m.lastOutputAt !== undefined && (m.status === 'working' || m.status === 'starting') ? minutes(now - m.lastOutputAt) : 0
  const bits = [
    m.role,
    m.status,
    m.leadId ? `under ${name(m.leadId)}` : '',
    activityOf(m.id) ?? '',
    quiet >= QUIET_NOTE_MIN ? `silent ${span(quiet)}` : '',
    m.role === 'worker' && m.status === 'working' ? diffLabel(m.diff) && `changed so far: ${diffLabel(m.diff)}` : ''
  ].filter(Boolean)
  return `${m.name} (${bits.join(', ')}${m.task && m.role !== 'lead' ? `: ${clip(m.task, 80)}` : ''})`
}

/** The team. `only`: the selected consoles — then just their members, their tasks, and the charter they work to. */
function fleetSection(only?: Set<string>): string {
  const s = useFleet.getState().state
  if (!s) return 'none'
  const members = Object.values(s.members).filter((m) => m.status !== 'closed' && (!only || only.has(m.id)))
  if (only && !members.length) return ''
  const name = (id?: string) => (!id ? '' : id === 'user' ? 'you' : (s.members[id]?.name ?? nameOf(id)))
  const lines: string[] = []
  const lead = activeLead()
  const leadIn = !only || (!!lead && only.has(lead.id))
  if (lead && leadIn) {
    const goal = lead.task ?? s.messages.find((m) => m.to === lead.id && m.kind === 'goal')?.text ?? ''
    lines.push(`active lead: ${lead.name}${lead.branch ? ` on ${lead.branch}` : ''} · goal: ${clip(goal, 400)}`)
  } else if (!only) lines.push('active lead: none (a new goal starts one)')
  // the charter's clock runs from its Lead's start, live console or not: one team at a time, so the newest
  const owner = lead ?? Object.values(s.members).filter((m) => m.role === 'lead' && m.status !== 'closed').sort((a, b) => b.createdAt - a.createdAt)[0]
  lines.push(...charterLines(s, owner))
  const tasks = s.tasks.filter((t) => leadIn || (t.owner && only?.has(t.owner)))
  if (tasks.length) {
    const now = Date.now()
    lines.push(
      'plan:\n' +
        tasks
          .map((t, i) => {
            const time = elapsedLabel(t, now)
            return `  ${i + 1}. [${t.status}] ${clip(t.title, 90)}${t.owner ? ` (${name(t.owner)})` : ''}${time ? ` · ${time}` : ''}${t.note ? ` · ${clip(t.note, 60)}` : ''}`
          })
          .join('\n')
    )
  }
  if (members.length) lines.push('members: ' + members.map((m) => memberLine(s, m, name)).join('; '))
  const open = s.asks.filter((a) => !a.answer && (!only || only.has(a.from)))
  if (open.length) lines.push('unanswered questions for the user: ' + open.map((a) => `${name(a.from)} asks "${clip(a.question, 140)}"${a.options.length ? ` [${a.options.join(' / ')}]` : ''}`).join('; '))
  if (s.ready && (!only || only.has(s.ready.leadId))) lines.push(`ready for review: branch ${s.ready.branch}, ${s.ready.commits} commit(s), ${s.ready.files.length} file(s): ${clip(s.ready.summary, 260)}`)
  return lines.join('\n')
}

const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`)

/** GitHub for this repo: CI on the current branch, every open PR's checks and the review comments not yet given to an agent. */
function ciSection(): string {
  const s = useCi.getState().status
  if (!s) return 'not checked yet'
  if (!s.ok) return s.error
  const lines: string[] = []
  const runs = s.runs.map((r) => `${r.workflow} ${r.detail.replace(/_/g, ' ')} (${ago(Date.now() - Date.parse(r.createdAt))} ago)`)
  lines.push(`this branch ${s.branch}: ${runs.length ? runs.join('; ') : 'no workflow runs'}`)
  const fb = useFeedback.getState().result
  for (const pr of s.prs) {
    const f = fb?.ok ? fb.prs.find((p) => p.number === pr.number) : undefined
    const owner = ownerOf(pr.branch)
    const failing = pr.checks.filter((c) => c.state === 'failing').map((c) => c.name)
    const fresh = f ? unsent(f) : []
    const bits = [
      pr.branch,
      pr.isDraft ? 'draft' : '',
      owner ? `agent on it: ${owner.name}` : agentMade(pr.branch) ? 'made by an agent' : '',
      pr.checks.length ? `checks ${pr.state}${failing.length ? ` (${failing.join(', ')})` : ''}` : 'no checks',
      f?.comments.length ? `${f.comments.length} review comment(s), ${fresh.length} not yet sent to an agent` : ''
    ].filter(Boolean)
    lines.push(`PR #${pr.number} "${clip(pr.title, 70)}" · ${bits.join(' · ')}`)
    for (const c of fresh.slice(-3)) lines.push(`  @${c.author}${c.kind === 'inline' ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : c.state === 'CHANGES_REQUESTED' ? ' (changes requested)' : ''}: "${clip(c.body, 140)}"`)
  }
  if (!s.prs.length) lines.push('no open pull requests')
  return lines.join('\n')
}

/** The user's other repos, from the last morning sweep this session (the ones that need something). */
async function sweepSection(): Promise<string> {
  const r = await invoke<SweepResult | null>('sweep:last').catch(() => null)
  if (!r) return 'not run this session (the morning-sweep playbook runs it)'
  const repos = r.repos.filter((x) => x.attention.length).sort((a, b) => b.score - a.score).slice(0, 8)
  const head = `swept ${r.repos.length} repos ${ago(Date.now() - r.at)} ago`
  if (!repos.length) return `${head}; nothing needs attention`
  return head + '\n' + repos.map((x) => `${x.name} (${x.branch}): ${x.attention.slice(0, 4).join('; ')}${x.plan ? `; next plan item: ${clip(x.plan.item, 80)}` : ''}`).join('\n')
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

/** What the user pointed at: the selected consoles (a selected group counts as its members) and the other selected tiles. Null with nothing selectable selected. */
export function selectionScope(): { consoles: string[]; nodes: BoardNode[] } | null {
  const ws = activeWs()
  if (!ws) return null
  const sel = new Set(useApp.getState().selection)
  const consoles = selectedConsoles()
  // wires and ink strokes can be selected too, but they are not things to ask about
  const nodes = ws.nodes.filter((n) => n.type !== 'console' && sel.has(n.id))
  return consoles.length || nodes.length ? { consoles, nodes } : null
}

/** A selected tile by name, for the line that says what the snapshot is scoped to. */
const tileName = (n: BoardNode) => {
  const t = n.title ?? n.data?.title
  return t ? `${n.type} "${clip(String(t), 40)}"` : n.type
}

/** The whole snapshot, under ~12k characters; only the selection when there is one. */
export async function boardContext(isCancelled: () => boolean = () => false): Promise<string> {
  const app = useApp.getState()
  const p = app.project
  if (!p) return ''
  const ws = activeWs()
  const scope = selectionScope()
  const consoles = allConsoles()
    .filter((c) => !scope || scope.consoles.includes(c.id))
    .sort((a, b) => (STATUS_ORDER[statusOf(a.id)] ?? 9) - (STATUS_ORDER[statusOf(b.id)] ?? 9))
  const tailChars = scope ? SCOPED_TAIL_CHARS : TAIL_CHARS
  const [git, known, sweep, tails] = await Promise.all([
    scope ? Promise.resolve('') : gitLine(p.path),
    // read alongside git, so Oracle waits for nothing extra; bounded, and empty when the repo cannot be read
    refreshKnowledge(),
    scope ? Promise.resolve('') : sweepSection(),
    Promise.all(consoles.map((c) => (statusOf(c.id) === 'exited' || !isLive(c.id) ? Promise.resolve('') : consoleTail(c.id, Math.max(1600, tailChars * 3)).catch(() => ''))))
  ])
  if (isCancelled()) return ''

  const fleet = useFleet.getState().state
  const cur = currentConsole()
  const scopeLine = scope
    ? `scope: the user selected ${[...consoles.map((c) => c.data.name as string), ...scope.nodes.map(tileName)].join(', ')} on the board and is asking about ${consoles.length + scope.nodes.length === 1 ? 'it' : 'them'}. The rest of the board is left out of this snapshot: answer about these. If the question needs the rest of the board, say so.`
    : ''
  const sel = selectedConsoles().map(nameOf)
  const head = [
    `project: ${p.name} (${p.path})`,
    git,
    scope ? '' : `workspaces: ${p.workspaces.map((w) => (w.id === ws?.id ? `${w.name} (active)` : w.name)).join(', ')}`,
    scopeLine || (sel.length ? `selected: ${sel.join(', ')}` : cur ? `most recently active console: ${nameOf(cur)}` : ''),
    `installed agents: ${agentsSection()}`
  ]
    .filter(Boolean)
    .join('\n')

  // the same facts, keys and provenance a charter cites, so an answer and a charter cannot disagree about the repo
  const knownText = `KNOWN ABOUT THIS REPO (cite one as fact:<key>)\n${knowledgeBlock(known, KNOWN_CHARS) || 'nothing yet: the Repo knowledge panel builds it'}`
  const teamBody = scope ? fleetSection(new Set(scope.consoles)) : fleetSection()
  const team = teamBody ? `TEAM${scope ? ' (the selected members only)' : ''}\n${teamBody}` : ''
  const github = scope ? '' : `CI AND PULL REQUESTS (GitHub, this repo)\n${ciSection()}\n\nOTHER REPOS (morning sweep)\n${sweep}`
  let boardText: string
  if (scope) {
    const lines = scope.nodes.map((n) => (ws ? nodeLine(n, ws, p.path) : null) ?? tileName(n))
    boardText = lines.length ? `SELECTED BOARD CONTENT\n${lines.map((l) => `- ${l}`).join('\n')}` : ''
  } else {
    const board = boardSection()
    boardText = board ? `BOARD CONTENT\n${board}` : 'BOARD CONTENT\n(nothing besides consoles)'
  }
  const thread = recentThread()
  const threadText = thread ? `RECENT COMMAND THREAD\n${thread}` : ''

  const consoleHead = (c: (typeof consoles)[number]) => {
    const m = fleet?.members[c.id]
    const w = p.workspaces.find((x) => x.id === c.workspaceId)
    const group = c.groupId ? w?.groups.find((g) => g.id === c.groupId)?.name : undefined
    const bits = [
      c.data.agentId,
      statusOf(c.id),
      activityOf(c.id) ?? '',
      m ? `${m.role}${m.task && m.role !== 'lead' ? `: ${clip(m.task, 100)}` : ''}` : '',
      group ? `group ${group}` : '',
      p.workspaces.length > 1 ? `in ${w?.name}` : ''
    ].filter(Boolean)
    return `## ${c.data.name} (${bits.join(' · ')})`
  }
  const rest = [team, github, boardText, threadText].filter(Boolean)
  const fixed = [head, knownText, ...rest].join('\n\n')
  const headers = consoles.map(consoleHead)
  const room = MAX_CHARS - fixed.length - headers.join('\n').length - 40
  const withTail = tails.filter(Boolean).length
  const per = withTail ? Math.min(tailChars, Math.floor(room / withTail) - 20) : 0
  const consoleText = consoles.length
    ? consoles.map((c, i) => (tails[i] && per >= 80 ? `${headers[i]}\n${cleanTail(tails[i], per)}` : headers[i])).join('\n')
    : scope
      ? '(no consoles selected)'
      : '(no consoles yet)'

  const all = `${head}\n\n${knownText}\n\n${scope ? 'SELECTED CONSOLES' : 'CONSOLES'} (newest output last)\n${consoleText}\n\n${rest.join('\n\n')}`
  return all.length > MAX_CHARS ? all.slice(0, MAX_CHARS - 2) + '\n…' : all
}
