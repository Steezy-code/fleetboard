// Board actions the voice planner (local rules or the CLI planner) can produce, plus how to resolve
// the names in them and run them.
import type { BoardNode, ConsoleData, Group, Role } from '@shared/types'
import { ROLES } from '@shared/types'
import { AGENTS, AGENT_ALIASES } from '@shared/agents'
import { charterMessage, coerceCharter } from '@shared/charter'
import { activeWs, allConsoles, useApp } from '../state/store'
import { agentLabel, isLive, killConsoles, pauseAll, resumeAll, sendToConsole, spawnConsoles } from '../engine/consoles'
import { handoff } from '../engine/handoff'
import { memberOf } from '../engine/fleet'
import { gateCharter } from '../fleet/charter'
import { ensureOrchestratorNode } from '../orchestration/connect'
import { DRAWER_NAMES, MODALS, isDrawer } from '../panels/names'

export type Action =
  | { type: 'spawn'; agent: string; count: number; team?: string; role?: Role | string; prompt?: string }
  | { type: 'send'; targets: string[]; text: string; submit: boolean }
  | { type: 'pause'; targets: string[] }
  | { type: 'resume'; targets: string[] }
  | { type: 'kill'; targets: string[] }
  | { type: 'group'; targets: string[]; name: string; role?: Role | string }
  | { type: 'ungroup'; team: string }
  | { type: 'deleteTeam'; team: string }
  | { type: 'wire'; from: string; to: string }
  | { type: 'orchestrator' }
  | { type: 'handoff'; from: string[]; toAgent?: string; to?: string[]; note?: string }
  | { type: 'openPanel'; name: string }
  | { type: 'focus'; target: string }
  | { type: 'zoom'; mode: 'in' | 'out' | 'fit' }
  | { type: 'newWorkspace'; name?: string }
  | { type: 'say'; text: string }

// ---------------------------------------------------------------- context

/** Consoles the last command touched ("group them", "pause them"). */
let lastIds: string[] = []
/** true once an earlier step of the running plan created / touched consoles ("spawn 3 codex then group them") */
let planFresh = false
export const beginPlanRun = () => {
  planFresh = false
}
const touch = (ids: string[]) => {
  lastIds = ids
  planFresh = true
}
/** Last time each console printed something (for "pass this task to codex"). */
const lastActive = new Map<string, number>()
export const markActive = (id: string) => lastActive.set(id, Date.now())

// ---------------------------------------------------------------- name resolution

export const norm = (s: string) => s.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '')

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] ?? 0
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      // every cell is inside the row by construction; 0 is what a cell outside it would cost
      const tmp = dp[j] ?? 0
      dp[j] = Math.min(tmp + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length] ?? 0
}

/** Agent id for a spoken / typed agent name ("claude code", "codecs", "Gemini CLI"), or null. */
export function agentFromWord(word: string): string | null {
  const w = word.toLowerCase().replace(/[^a-z0-9.\- ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!w) return null
  if (AGENT_ALIASES[w]) return AGENT_ALIASES[w]
  const n = norm(w)
  const custom = useApp.getState().settings.customAgents
  for (const a of [...AGENTS, ...custom]) {
    if (norm(a.id) === n || norm(a.name) === n || norm(a.bin) === n) return a.id
  }
  for (const [alias, id] of Object.entries(AGENT_ALIASES)) if (norm(alias) === n) return id
  return null
}

/** Longest agent alias that appears as whole words in the text. */
export function findAgentIn(text: string): { id: string; alias: string } | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9.\- ]+/g, ' ').replace(/\s+/g, ' ')} `
  const custom = useApp.getState().settings.customAgents
  const names: [string, string][] = [
    ...Object.entries(AGENT_ALIASES),
    ...[...AGENTS, ...custom].flatMap((a) => [[a.name.toLowerCase(), a.id] as [string, string], [a.id, a.id] as [string, string]])
  ]
  names.sort((a, b) => b[0].length - a[0].length)
  for (const [alias, id] of names) {
    if (alias.length < 2) continue
    if (t.includes(` ${alias} `) || t.includes(` ${alias}s `)) return { id, alias }
  }
  return null
}

type ConsoleRef = BoardNode<ConsoleData> & { workspaceId: string }

const consoles = (): ConsoleRef[] => allConsoles() as ConsoleRef[]

const ALL_WORDS = new Set(['all', 'everyone', 'everybody', 'everything', 'allagents', 'allconsoles', 'allofthem', 'eachagent', 'every agent', 'everyagent', 'theboard', 'allterminals'])
const THEM_WORDS = new Set(['them', 'these', 'those', 'they', 'thoseagents', 'theseagents', 'thenewones', 'newones', 'thoseconsoles', 'theseconsoles'])
const THIS_WORDS = new Set(['this', 'it', 'selected', 'selection', 'theselectedone', 'thisone', 'thisconsole', 'thisagent', 'current', 'me'])

const wsGroups = (): Group[] => activeWs()?.groups ?? []

/** Team (group) of the active workspace for a name / id / "group 2" / role. */
export function resolveTeam(ref: string): Group | null {
  const groups = wsGroups()
  if (!ref) return null
  const byId = groups.find((g) => g.id === ref)
  if (byId) return byId
  const raw = ref.toLowerCase().replace(/^(the|a)\s+/, '').trim()
  const stripped = raw.replace(/\s+(group|team)$/, '').replace(/^(group|team)\s+(called|named)\s+/, '')
  const n = norm(stripped)
  const exact = groups.find((g) => norm(g.name) === n || norm(g.name) === norm(raw))
  if (exact) return exact
  const ord = /^(?:group|team)\s*(\d+)$/.exec(raw) ?? /^(\d+)$/.exec(stripped)
  if (ord) return groups[Number(ord[1]) - 1] ?? null
  const ordWord = /^(first|second|third|fourth|fifth|last)\s+(?:group|team)$/.exec(raw)
  if (ordWord) {
    const word = ordWord[1] ?? ''
    const i = word === 'last' ? groups.length - 1 : { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 }[word]
    return i === undefined ? null : groups[i] ?? null
  }
  const byRole = groups.find((g) => norm(g.role) === n)
  if (byRole) return byRole
  if (n.length >= 4) {
    const fuzzy = groups.filter((g) => lev(norm(g.name), n) <= 1)
    if (fuzzy.length === 1) return fuzzy[0] ?? null
  }
  return null
}

/**
 * Resolve one reference to console ids: id, console name ("maya 2"), team, agent ("codex"),
 * "all", "them" (last touched), "this" (selection / most recently active). Empty when unknown.
 */
export function resolveRef(ref: string, scope: 'all' | 'workspace' = 'all'): string[] {
  const app = useApp.getState()
  const list = scope === 'workspace' ? consoles().filter((c) => c.workspaceId === app.project?.activeWorkspaceId) : consoles()
  const r = ref.trim().replace(/^@/, '')
  if (!r) return []
  const direct = list.find((c) => c.id === r)
  if (direct) return [direct.id]
  const n = norm(r.replace(/^(the|a)\s+/i, ''))
  if (ALL_WORDS.has(n) || ALL_WORDS.has(r.toLowerCase())) {
    // "all" means the board in front of you
    return list.filter((c) => c.workspaceId === app.project?.activeWorkspaceId).map((c) => c.id)
  }
  if (THEM_WORDS.has(n)) {
    const last = lastIds.filter((id) => list.some((c) => c.id === id))
    if (planFresh && last.length) return last
    const sel = selectedConsoles()
    return sel.length ? sel : last
  }
  if (THIS_WORDS.has(n)) {
    const cur = currentConsole()
    return cur ? [cur] : []
  }
  const byName = list.filter((c) => norm(c.data.name) === n)
  if (byName.length) return byName.map((c) => c.id)
  const team = resolveTeam(r)
  if (team) return list.filter((c) => c.groupId === team.id).map((c) => c.id)
  // "the codex agents", "claude consoles"
  const agentWord = r.toLowerCase().replace(/^(the|all|all the)\s+/, '').replace(/\s+(agents?|consoles?|terminals?|ones?)$/, '')
  const agent = agentFromWord(agentWord)
  if (agent) {
    const byAgent = list.filter((c) => c.data.agentId === agent)
    if (byAgent.length) return byAgent.map((c) => c.id)
  }
  if (n.length >= 4) {
    const [onlyFuzzy, ...restFuzzy] = list.filter((c) => lev(norm(c.data.name), n) <= 1)
    if (onlyFuzzy && !restFuzzy.length) return [onlyFuzzy.id]
  }
  return []
}

/** "them" / "these": resolved when the step runs, not when it is planned. */
export const isPronoun = (ref: string) => THEM_WORDS.has(norm(ref))

/** Resolve many references; unknown ones are reported in `missing`. */
export function resolveRefs(refs: string[], scope: 'all' | 'workspace' = 'all'): { ids: string[]; missing: string[] } {
  const ids = new Set<string>()
  const missing: string[] = []
  for (const ref of refs) {
    const got = resolveRef(ref, scope)
    if (!got.length) missing.push(ref)
    got.forEach((id) => ids.add(id))
  }
  return { ids: [...ids], missing }
}

export function selectedConsoles(): string[] {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws) return []
  const sel = new Set(app.selection)
  const ids = ws.nodes.filter((n) => n.type === 'console' && sel.has(n.id)).map((n) => n.id)
  // a selected team counts as its members
  ws.groups.filter((g) => sel.has(g.id)).forEach((g) => ws.nodes.forEach((n) => n.type === 'console' && n.groupId === g.id && ids.push(n.id)))
  return [...new Set(ids)]
}

/** The console "this" refers to: selection, maximized one, else the most recently active. */
export function currentConsole(): string | null {
  const [firstSelected] = selectedConsoles()
  if (firstSelected) return firstSelected
  const app = useApp.getState()
  if (app.focusedNode && consoles().some((c) => c.id === app.focusedNode)) return app.focusedNode
  const ws = activeWs()
  const here = consoles().filter((c) => c.workspaceId === ws?.id)
  let best: string | null = null
  let bestAt = -1
  for (const c of here) {
    const at = lastActive.get(c.id) ?? (isLive(c.id) ? 0 : -1)
    if (at > bestAt) {
      bestAt = at
      best = c.id
    }
  }
  return best
}

export const nameOf = (id: string) => consoles().find((c) => c.id === id)?.data.name ?? wsGroups().find((g) => g.id === id)?.name ?? id

export const namesOf = (ids: string[], max = 6) => {
  const names = ids.map(nameOf)
  return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ')
}

const roleFor = (r?: string): Role | undefined => {
  if (!r) return undefined
  const n = norm(r)
  return ROLES.find((x) => norm(x) === n || norm(x).replace(/s$/, '') === n.replace(/s$/, '') || (n === 'test' && x === 'Testers') || (n === 'review' && x === 'Reviewers') || (n === 'doc' && x === 'Docs'))
}

export const PANEL_ALIASES: Record<string, { name: string; drawer?: boolean }> = {
  missionmap: { name: 'missionMap' }, map: { name: 'missionMap' }, mission: { name: 'missionMap' },
  loops: { name: 'loops' }, loop: { name: 'loops' }, memory: { name: 'memory' }, memories: { name: 'memory' },
  knowledge: { name: 'knowledge' }, repoknowledge: { name: 'knowledge' },
  documents: { name: 'documents' }, document: { name: 'documents' }, docs: { name: 'documents' }, documentsstudio: { name: 'documents' },
  diagrams: { name: 'diagrams' }, diagram: { name: 'diagrams' }, code: { name: 'code' }, codestudio: { name: 'code' }, files: { name: 'code' },
  markdown: { name: 'markdown' }, vault: { name: 'markdown' }, notes: { name: 'markdown' },
  usage: { name: 'usage', drawer: true }, limits: { name: 'usage', drawer: true },
  settings: { name: 'settings' }, preferences: { name: 'settings' }, presets: { name: 'presets' }, composer: { name: 'composer' },
  skills: { name: 'skills' }, handoff: { name: 'handoff' }, spawn: { name: 'spawn' },
  orchestrator: { name: 'orchestrator', drawer: true }, git: { name: 'git', drawer: true }, accounts: { name: 'accounts', drawer: true },
  ci: { name: 'ci', drawer: true }, reviews: { name: 'ci', drawer: true }, checks: { name: 'ci', drawer: true },
  profiles: { name: 'accounts', drawer: true }, chat: { name: 'chat', drawer: true }, thread: { name: 'chat', drawer: true },
  journal: { name: 'journal', drawer: true }, log: { name: 'journal', drawer: true }, nightlog: { name: 'journal', drawer: true },
  sweep: { name: 'sweep' }, morningsweep: { name: 'sweep' }
}

/** The panel a word names: an alias, or a panel's own name (panels/names.ts); null for no such panel. */
export function panelFor(word: string): { name: string; drawer?: boolean } | null {
  const n = norm(word.replace(/\b(the|my|panel|studio|drawer|window|view)\b/gi, ''))
  const alias = PANEL_ALIASES[n]
  if (alias) return alias
  const own = [...MODALS, ...DRAWER_NAMES].find((name) => norm(name) === n)
  return own ? { name: own, drawer: isDrawer(own) } : null
}

// ---------------------------------------------------------------- describe / safety

export function describe(a: Action): string {
  switch (a.type) {
    case 'spawn':
      return `spawn ${a.count} ${agentLabel(agentFromWord(a.agent) ?? a.agent)}${a.team ? ` in ${a.team}` : ''}${a.prompt ? `, told “${clip(a.prompt)}”` : ''}`
    case 'send':
      return `${a.submit ? 'send' : 'type'} “${clip(a.text)}” → ${who(a.targets)}`
    case 'pause':
      return `pause ${who(a.targets)}`
    case 'resume':
      return `resume ${who(a.targets)}`
    case 'kill': {
      const ids = resolveRefs(a.targets, 'workspace').ids
      return `close ${ids.length} console${ids.length === 1 ? '' : 's'} · ${namesOf(ids)}`
    }
    case 'group':
      return `group ${who(a.targets, 'workspace')} as ${a.name}`
    case 'ungroup':
      return `ungroup ${resolveTeam(a.team)?.name ?? a.team}`
    case 'deleteTeam': {
      const g = resolveTeam(a.team)
      const n = g ? teamMembers(g.id).length : 0
      return `delete group ${g?.name ?? a.team}${n ? ` and close its ${n} console${n === 1 ? '' : 's'}` : ''}`
    }
    case 'wire':
      return `wire ${refLabel(a.from)} → ${refLabel(a.to)}`
    case 'orchestrator':
      return 'add an orchestrator'
    case 'handoff':
      return `hand off ${namesOf(resolveRefs(a.from).ids) || 'the current console'} → ${a.toAgent ? `new ${agentLabel(agentFromWord(a.toAgent) ?? a.toAgent)}` : (a.to ?? []).join(', ')}${a.note ? ` with “${clip(a.note)}”` : ''}`
    case 'openPanel':
      return `open ${a.name}`
    case 'focus':
      return `go to ${a.target}`
    case 'zoom':
      return a.mode === 'fit' ? 'fit the board' : `zoom ${a.mode}`
    case 'newWorkspace':
      return `new workspace${a.name ? ` ${a.name}` : ''}`
    case 'say':
      return `say “${clip(a.text)}”`
  }
}

/** Names for a step's targets; pronouns stay as said until the step runs. */
function who(targets: string[], scope: 'all' | 'workspace' = 'all') {
  if (targets.length && targets.every(isPronoun)) return targets.join(', ')
  return namesOf(resolveRefs(targets, scope).ids) || targets.join(', ')
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function refLabel(ref: string) {
  if (/^orchestrator$/i.test(ref.trim())) return 'Orchestrator'
  const team = resolveTeam(ref)
  if (team) return team.name
  const ids = resolveRef(ref)
  return ids.length ? namesOf(ids) : ref
}

const teamMembers = (gid: string) => activeWs()?.nodes.filter((n) => n.type === 'console' && n.groupId === gid).map((n) => n.id) ?? []

/** Words the user must have said for the planner to be allowed to do this without asking. */
const ASKED: Partial<Record<Action['type'], RegExp>> = {
  spawn: /\b(spawn|start|launch|create|add|open|make|spin|fire|bring|new|need|want|get|give|more|another)\b/i,
  send: /\b(tell|ask|send|say|type|run|have|get|make|let|instruct|order|message|notify|remind|assign|give|everyone|all)\b/i,
  pause: /\b(pause|freeze|hold|suspend|stop|wait)\b/i,
  resume: /\b(resume|unpause|continue|unfreeze|restart|wake)\b/i,
  kill: /\b(kill|close|delete|remove|terminate|shut|end|destroy|get rid|clear)\b/i,
  group: /\b(group|team|put|move|organi[sz]e|together|squad|crew)\b/i,
  ungroup: /\b(ungroup|disband|split|break|dissolve|remove)\b/i,
  deleteTeam: /\b(delete|remove|kill|close|destroy|get rid)\b/i,
  wire: /\b(wire|connect|link|hook|attach|orchestrat)\w*/i,
  orchestrator: /\borchestrat\w*/i,
  handoff: /\b(pass|hand|give|handoff|transfer|move|continue)\b/i,
  newWorkspace: /\b(workspace|tab)\b/i
}

/** Why this plan needs a spoken "confirm" (empty when it can run straight away). */
export function confirmReasons(actions: Action[], userText: string, fromPlanner: boolean): string[] {
  const reasons: string[] = []
  // counted over the whole plan: split across steps, eight spawns and seven sends ask like one would
  let spawns = 0
  const messaged = new Set<string>()
  for (const a of actions) {
    if (a.type === 'kill' && resolveRefs(a.targets, 'workspace').ids.length) reasons.push('closes consoles')
    if (a.type === 'deleteTeam') {
      const g = resolveTeam(a.team)
      if (g && teamMembers(g.id).some(isLive)) reasons.push('closes live consoles')
    }
    if (a.type === 'send') for (const id of resolveRefs(a.targets).ids) messaged.add(id)
    if (a.type === 'spawn') {
      spawns += Math.max(1, Math.round(Number(a.count) || 1))
      // a new agent sets to work on words a model wrote, in its own console: worth a look first, and
      // always when it would act on them without asking
      if (a.prompt && (fromPlanner || useApp.getState().settings.autoApprove)) reasons.push('starts an agent with a task')
    }
    if (fromPlanner) {
      const re = ASKED[a.type]
      if (re && !re.test(userText)) reasons.push(`adds a step you didn't ask for (${a.type})`)
    }
  }
  if (messaged.size > 6) reasons.push('messages more than 6 consoles')
  if (spawns > 8) reasons.push(`spawns ${spawns} consoles`)
  return [...new Set(reasons)]
}

/** "DAX, Maya 2, Rafa 2, about to close 4 consoles, say confirm" */
export function confirmPrompt(actions: Action[]): string {
  const parts: string[] = []
  let names: string[] = []
  for (const a of actions) {
    if (a.type === 'kill') {
      const ids = resolveRefs(a.targets, 'workspace').ids
      names = names.concat(ids.map(nameOf))
      parts.push(`close ${ids.length} console${ids.length === 1 ? '' : 's'}`)
    } else if (a.type === 'deleteTeam') {
      const g = resolveTeam(a.team)
      const m = g ? teamMembers(g.id) : []
      names = names.concat(m.map(nameOf))
      parts.push(`delete the ${g?.name ?? a.team} group${m.length ? ` and close ${m.length} console${m.length === 1 ? '' : 's'}` : ''}`)
    } else if (a.type === 'send') {
      const ids = resolveRefs(a.targets).ids
      parts.push(ids.length > 6 ? `send that to ${ids.length} consoles` : `message ${namesOf(ids, 3)}`)
    } else if (a.type !== 'say') parts.push(describe(a))
  }
  const lead = names.length && names.length <= 6 ? `${names.join(', ')}, ` : ''
  return `${lead}about to ${parts.join(', then ')}, say confirm`
}

// ---------------------------------------------------------------- execution

export interface ActionResult {
  ok: boolean
  /** line for the thread ("Docs group notified: run the tests") */
  line: string
}

function installed(agentId: string): boolean {
  const app = useApp.getState()
  if (app.settings.customAgents.some((a) => a.id === agentId)) return true
  if (agentId === 'shell') return true
  if (!app.agents.length) return true // detection not finished: let the console report it
  return !!app.agents.find((a) => a.id === agentId)?.path
}

/** Board item id (node or group) for a wire endpoint. */
function wireEnd(ref: string): string | null {
  if (/^(the\s+)?(new\s+)?orchestrator$/i.test(ref.trim())) return ensureOrchestratorNode()
  const ws = activeWs()
  if (ws?.nodes.some((n) => n.id === ref) || ws?.groups.some((g) => g.id === ref)) return ref
  const team = resolveTeam(ref)
  if (team) return team.id
  const ids = resolveRef(ref, 'workspace')
  return ids.length === 1 ? ids[0] ?? null : null
}

const afterLayout = (fn: () => void) => window.setTimeout(fn, 60)

export async function runAction(a: Action): Promise<ActionResult> {
  const app = useApp.getState()
  switch (a.type) {
    case 'spawn': {
      const agentId = agentFromWord(a.agent) ?? (a.agent ? null : app.settings.defaultAgent)
      if (!agentId) return { ok: false, line: `I don't know an agent called “${a.agent}”.` }
      if (!installed(agentId)) return { ok: false, line: `${agentLabel(agentId)} isn't installed.` }
      const count = Math.max(1, Math.min(24, Math.round(Number(a.count) || 1)))
      let group: { name: string; role: Role } | string | undefined
      if (a.team) {
        const existing = resolveTeam(a.team)
        group = existing ? existing.id : { name: titleCase(a.team), role: roleFor(a.role ?? a.team) ?? 'General' }
      }
      const ids = spawnConsoles({ agentId, count, group, initialPrompt: a.prompt })
      touch(ids)
      afterLayout(() => useApp.getState().fitAll())
      return { ok: !!ids.length, line: `Spawned ${count} ${agentLabel(agentId)} → ${namesOf(ids)}` }
    }
    case 'send': {
      const { ids, missing } = resolveRefs(a.targets)
      if (!ids.length) return { ok: false, line: `No console matches ${a.targets.join(', ')}.` }
      // a message submitted to a team member gives the team work, so it crosses the gate; one only typed waits for Enter, which is already a glance
      const members = a.submit ? ids.filter((id) => memberOf(id)) : []
      const direct = ids.filter((id) => !members.includes(id))
      direct.forEach((id) => sendToConsole(id, a.text, a.submit))
      const to = members[0] && memberOf(members[0])
      if (to) {
        const confirmed = await gateCharter(coerceCharter(null, a.text), to)
        if (!confirmed) return { ok: false, line: `Not sent to ${namesOf(members)}: the charter was dismissed${direct.length ? ` (${namesOf(direct)} got it)` : ''}.` }
        members.forEach((id) => sendToConsole(id, charterMessage(confirmed, a.text), true))
      }
      touch(ids)
      const onlyTarget = a.targets.length === 1 ? a.targets[0] : undefined
      const team = onlyTarget ? resolveTeam(onlyTarget) : null
      const who = team ? `${team.name} group` : namesOf(ids)
      return {
        ok: true,
        line: `${who} ${a.submit ? 'notified' : 'typed'}: ${clip(a.text, 80)}${missing.length ? ` (no match for ${missing.join(', ')})` : ''}`
      }
    }
    case 'pause':
    case 'resume': {
      const { ids } = resolveRefs(a.targets)
      if (!ids.length) return { ok: false, line: `No console matches ${a.targets.join(', ')}.` }
      await (a.type === 'pause' ? pauseAll(ids) : resumeAll(ids))
      touch(ids)
      return { ok: true, line: `${a.type === 'pause' ? 'Paused' : 'Resumed'} ${namesOf(ids)}` }
    }
    case 'kill': {
      const { ids } = resolveRefs(a.targets, 'workspace')
      if (!ids.length) return { ok: false, line: `No console here matches ${a.targets.join(', ')}.` }
      const names = namesOf(ids)
      await killConsoles(ids, { confirm: false })
      lastIds = []
      return { ok: true, line: `Closed ${names}` }
    }
    case 'group': {
      const ws = activeWs()
      const { ids } = resolveRefs(a.targets, 'workspace')
      if (!ws || !ids.length) return { ok: false, line: `Nothing to group for ${a.targets.join(', ') || 'that'}.` }
      const nodes = ws.nodes.filter((n) => ids.includes(n.id))
      const name = titleCase(a.name || `Group ${ws.groups.length + 1}`)
      let gid = resolveTeam(name)?.id
      if (!gid) {
        const pad = 24
        const x = Math.min(...nodes.map((n) => n.x)) - pad
        const y = Math.min(...nodes.map((n) => n.y)) - pad - 34
        gid = app.addGroup({ name, role: roleFor(a.role ?? name) ?? 'General', x, y, w: 10, h: 10 })
      }
      nodes.forEach((n) => app.updateNode(n.id, { groupId: gid }))
      useApp.getState().fitGroup(gid)
      touch(ids)
      return { ok: true, line: `Grouped ${namesOf(ids)} as ${name}` }
    }
    case 'ungroup': {
      const g = resolveTeam(a.team)
      if (!g) return { ok: false, line: `No group called ${a.team}.` }
      touch(teamMembers(g.id))
      app.removeGroup(g.id, false)
      return { ok: true, line: `Ungrouped ${g.name}` }
    }
    case 'deleteTeam': {
      const g = resolveTeam(a.team)
      if (!g) return { ok: false, line: `No group called ${a.team}.` }
      const members = teamMembers(g.id)
      if (members.length) await killConsoles(members, { confirm: false })
      useApp.getState().removeGroup(g.id, true)
      return { ok: true, line: `Deleted ${g.name}${members.length ? ` and its ${members.length} console${members.length === 1 ? '' : 's'}` : ''}` }
    }
    case 'orchestrator': {
      const id = ensureOrchestratorNode()
      if (id) afterLayout(() => useApp.getState().fitAll())
      return { ok: !!id, line: 'Orchestrator on the board' }
    }
    case 'wire': {
      const from = wireEnd(a.from)
      const to = wireEnd(a.to)
      if (!from || !to) return { ok: false, line: `Couldn't find ${!from ? a.from : a.to} to wire.` }
      if (from === to) return { ok: false, line: 'Nothing to wire.' }
      app.addWire(from, to)
      afterLayout(() => useApp.getState().fitAll())
      return { ok: true, line: `Wired ${nameOrKind(from)} → ${nameOrKind(to)}` }
    }
    case 'handoff': {
      let fromIds = resolveRefs(a.from ?? []).ids
      if (!fromIds.length) {
        const cur = currentConsole()
        if (cur) fromIds = [cur]
      }
      if (!fromIds.length) return { ok: false, line: 'Select the console to hand off first.' }
      const toAgentId = a.toAgent ? agentFromWord(a.toAgent) : null
      const toIds = a.to?.length ? resolveRefs(a.to).ids : []
      if (!toAgentId && !toIds.length) return { ok: false, line: `I don't know who should take it.` }
      if (toAgentId && !installed(toAgentId)) return { ok: false, line: `${agentLabel(toAgentId)} isn't installed.` }
      try {
        const ids = await handoff({ fromIds, toAgentId: toAgentId ?? undefined, toIds: toIds.length ? toIds : undefined, note: a.note })
        touch(ids)
        return { ok: true, line: `Handed ${namesOf(fromIds)} → ${ids.length ? namesOf(ids) : toAgentId ? agentLabel(toAgentId) : namesOf(toIds)}` }
      } catch (e: any) {
        return { ok: false, line: `Handoff failed: ${e?.message ?? e}` }
      }
    }
    case 'openPanel': {
      const p = panelFor(a.name)
      // a name that is no panel opened nothing and still said "Opened"
      if (!p) return { ok: false, line: `There is no ${a.name} panel` }
      if (p.drawer) app.openDrawer(p.name, {})
      else app.openPanel(p.name)
      return { ok: true, line: `Opened ${a.name}` }
    }
    case 'focus': {
      const team = resolveTeam(a.target)
      if (team) {
        app.focusItem(team.id)
        return { ok: true, line: `Showing ${team.name}` }
      }
      const ids = resolveRef(a.target)
      const c = consoles().find((x) => x.id === ids[0])
      if (!c) return { ok: false, line: `Couldn't find ${a.target}.` }
      if (c.workspaceId !== app.project?.activeWorkspaceId) app.switchWorkspace(c.workspaceId)
      afterLayout(() => useApp.getState().focusItem(c.id))
      return { ok: true, line: `Showing ${c.data.name}` }
    }
    case 'zoom':
      if (a.mode === 'fit') app.fitAll()
      else app.zoomAt(a.mode === 'in' ? 1.25 : 0.8)
      return { ok: true, line: a.mode === 'fit' ? 'Fit the board' : `Zoomed ${a.mode}` }
    case 'newWorkspace': {
      app.addWorkspace(a.name ? titleCase(a.name) : undefined)
      return { ok: true, line: `New workspace${a.name ? ` ${titleCase(a.name)}` : ''}` }
    }
    case 'say':
      return { ok: true, line: '' }
  }
}

function nameOrKind(id: string) {
  const ws = activeWs()
  const n = ws?.nodes.find((x) => x.id === id)
  if (n?.type === 'orchestrator') return 'Orchestrator'
  return nameOf(id)
}

const titleCase = (s: string) =>
  s
    .trim()
    .replace(/^(the|a)\s+/i, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())

/** Validate / coerce a planner action. Returns null when it is unusable. */
export function coerceAction(raw: any): Action | null {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)])
  const s = (v: any) => (v == null ? '' : String(v))
  switch (raw.type) {
    case 'spawn':
      return { type: 'spawn', agent: s(raw.agent), count: Number(raw.count) || 1, team: raw.team ? s(raw.team) : undefined, role: raw.role ? s(raw.role) : undefined, prompt: raw.prompt ? s(raw.prompt) : undefined }
    case 'send':
      if (!raw.text) return null
      return { type: 'send', targets: arr(raw.targets), text: s(raw.text), submit: raw.submit !== false }
    case 'pause':
    case 'resume':
    case 'kill':
      return { type: raw.type, targets: arr(raw.targets) }
    case 'group':
      return { type: 'group', targets: arr(raw.targets), name: s(raw.name), role: raw.role ? s(raw.role) : undefined }
    case 'ungroup':
    case 'deleteTeam':
      return { type: raw.type, team: s(raw.team) }
    case 'wire':
      return { type: 'wire', from: s(raw.from), to: s(raw.to) }
    case 'orchestrator':
      return { type: 'orchestrator' }
    case 'handoff':
      return { type: 'handoff', from: arr(raw.from), toAgent: raw.toAgent ? s(raw.toAgent) : undefined, to: raw.to ? arr(raw.to) : undefined, note: raw.note ? s(raw.note) : undefined }
    case 'openPanel':
      return { type: 'openPanel', name: s(raw.name) }
    case 'focus':
      return { type: 'focus', target: s(raw.target) }
    case 'zoom':
      return { type: 'zoom', mode: raw.mode === 'out' ? 'out' : raw.mode === 'fit' ? 'fit' : 'in' }
    case 'newWorkspace':
      return { type: 'newWorkspace', name: raw.name ? s(raw.name) : undefined }
    case 'say':
      return raw.text ? { type: 'say', text: s(raw.text) } : null
  }
  return null
}
