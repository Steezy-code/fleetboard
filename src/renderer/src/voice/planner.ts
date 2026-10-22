// Command routing for the bar and push-to-talk:
//   1. a pending confirmation consumes "confirm" / "cancel"
//   2. dictation: "@maya …", "Maya, …", "to Maya, …" → typed into those consoles (voice: no Enter; typed: Enter)
//   3. a fast local rule parser for common board commands (offline, instant)
//   4. Helm (settings.helm): reads the whole board, answers and/or suggests 1-3 one-click routes
//   5. Helm off (or failed): work → the Lead; board commands → the CLI planner (JSON actions)
// Destructive or unrequested steps wait for a spoken / clicked confirmation.
import { activeLead, looksLikeBoardCommand, sendGoal } from '../engine/fleet'
import { AGENTS } from '@shared/agents'
import { activeWs, allConsoles, useApp } from '../state/store'
import { agentLabel, isLive } from '../engine/consoles'
import { extractJson, runCli, uid } from '../lib/api'
import {
  type Action,
  agentFromWord,
  coerceAction,
  confirmPrompt,
  confirmReasons,
  currentConsole,
  describe,
  findAgentIn,
  isPronoun,
  beginPlanRun,
  namesOf,
  norm,
  panelFor,
  resolveRef,
  resolveRefs,
  resolveTeam,
  runAction
} from './actions'
import { setVoice, showReply, useThread, useVoice } from './thread'
import { askHelm, dismissHelm, pickHelmOption, runHelmOption, showHelm, useHelm } from './helm/helm'
import { cycleFront, frontItem, runAction as runInboxAction } from '../fleet/inboxModel'
import { brainstormTopic, startBrainstorm } from './helm/brainstorm'
import { speak, stopSpeaking } from './tts'

export type Source = 'voice' | 'typed'

// ---------------------------------------------------------------- text helpers

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, few: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  twenty: 20, dozen: 12, another: 1
}
const DIGIT_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|twenty|dozen'

/** Lowercase, drop punctuation and politeness, number words → digits. */
export function normalize(text: string): string {
  let t = ` ${text.toLowerCase()} `
    .replace(/[“”"]/g, '')
    .replace(/[!?;]+/g, ' ')
    .replace(/\.(\s|$)/g, ' ')
    .replace(/,/g, ' , ')
  t = t.replace(new RegExp(`\\b(${DIGIT_WORDS})\\b`, 'g'), (w) => String(NUMBER_WORDS[w]))
  t = t.replace(/\s+/g, ' ').trim()
  // fillers at the start / end
  for (let i = 0; i < 4; i++) {
    t = t
      .replace(/^(,\s*)?(ok(ay)?|hey|so|um+|uh+|well|alright|right|please|now|and|also|then|yeah|yes|cool|great|can you|could you|would you|will you|i want you to|i'd like you to|let's|lets|go ahead and|just)\b\s*,?\s*/, '')
      .replace(/\s*,?\s*\b(please|for me|thanks|thank you|now|right now)$/, '')
      .trim()
  }
  return t.replace(/\s*,\s*$/, '').trim()
}

const numIn = (s: string): number | null => {
  const m = /\b(\d+)\b/.exec(s)
  if (m) return Number(m[1])
  if (/\b(a few|several|some)\b/.test(s)) return 3
  if (/\b(a couple|a pair)\b/.test(s)) return 2
  return null
}

/** "maya and rafa, iris" → ["maya", "rafa", "iris"] */
const splitList = (s: string) =>
  s
    .split(/\s*(?:,|\band\b|&|\bplus\b)\s*/)
    .map((x) => x.replace(/^(the|both|consoles?|agents?)\s+/, '').trim())
    .filter(Boolean)

const strip = (s: string) => s.replace(/^(the|a|an|my)\s+/, '').trim()

/** Resolve every item of a list, or null when any is unknown (the planner gets a go then). */
function refsOrNull(list: string[], scope: 'all' | 'workspace' = 'all'): string[] | null {
  if (!list.length) return null
  if (list.every(isPronoun)) return list
  const { ids, missing } = resolveRefs(list, scope)
  return missing.length || !ids.length ? null : list
}

// ---------------------------------------------------------------- dictation

interface Dictation {
  targets: string[]
  text: string
}

/** "@maya @rafa fix it", "at maya, fix it", "Maya, fix it", "to Maya: fix it", "everyone, run tests". */
export function parseDictation(raw: string): Dictation | null {
  const text = raw.trim()
  // explicit @mentions at the start
  const mentions: string[] = []
  let rest = text
  for (;;) {
    const m = /^@([\w.-]+)[\s,:]*/.exec(rest)
    const name = m?.[1]
    if (!m || !name) break
    mentions.push(name)
    rest = rest.slice(m[0].length)
  }
  if (mentions.length) {
    if (!rest.trim()) return null
    return { targets: mentions, text: rest.trim() }
  }
  // spoken: "at Maya, …" / "to Maya, …" / "Maya, …" / "Maya 2: …" / "hey Maya, …"
  const m = /^(?:(?:hey|ok|okay)\s+)?(?:at|to|@)?\s*([\w][\w .'-]{0,40}?)\s*[,:]\s*(.+)$/is.exec(text)
  if (!m) return null
  const [, addressed = '', body = ''] = m
  const who = addressed.replace(/\s+(\d+|one|two|three|four|five|six|seven|eight|nine)$/i, (_x, n) => ` ${NUMBER_WORDS[n.toLowerCase()] ?? n}`)
  const names = splitList(who.toLowerCase())
  if (!names.length) return null
  // only console names, team names or everyone count as an address (not agents: "codex, …" is ambiguous)
  for (const n of names) {
    const isAll = /^(everyone|everybody|all|all agents|team)$/.test(n)
    const named = allConsoles().some((c) => norm(c.data.name) === norm(n)) || !!resolveTeam(n)
    if (!isAll && !named) return null
  }
  return { targets: names, text: body.trim() }
}

// ---------------------------------------------------------------- local rules

export interface LocalPlan {
  actions: Action[]
  say: string
}

const VERB_SPAWN = /^(?:spawn|start|launch|create|add|open|make|spin up|fire up|bring up|boot up|give me|get me|i need|i want|new|another|(?=\d+ (?:more|new|extra)\b))\b\s*/
const VERB_KILL = /^(kill|close|delete|remove|terminate|shut down|shutdown|end|destroy|get rid of)\b\s*/

function ruleSpawn(t: string): LocalPlan | null {
  if (/^new console$|^(open|add|create|spawn) (a )?(new )?console$/.test(t)) {
    const agent = useApp.getState().settings.defaultAgent
    return { actions: [{ type: 'spawn', agent, count: 1 }], say: `Spawning a ${agentLabel(agent)} console.` }
  }
  const vm = VERB_SPAWN.exec(t)
  if (!vm) return null
  let rest = t.slice(vm[0].length)
  // team clause: "in a team called reviewers", "as reviewers", "into backend"
  let team: string | undefined
  const tm = /\s+(in|into|as|for|on|to)\s+(?:a\s+)?(?:new\s+)?(?:(?:team|group)\s+)?(?:(?:called|named)\s+)?(.+)$/.exec(rest)
  if (tm) {
    const [, preposition = '', named = ''] = tm
    const cand = named.replace(/\s+(team|group)$/, '').replace(/^the\s+/, '').trim()
    const ok = preposition === 'to' ? !!resolveTeam(cand) : !!cand && !/^(the board|here|this workspace|parallel)$/.test(cand)
    if (ok) {
      team = cand
      rest = rest.slice(0, tm.index)
    }
  }
  const count = numIn(rest) ?? 1
  const found = findAgentIn(rest)
  const generic = /\b(agents?|consoles?|terminals?|instances?|sessions?|ones?|more|workers?)\b/.test(rest)
  let agent = found?.id
  if (!agent) {
    if (!generic) return null
    agent = useApp.getState().settings.defaultAgent
  }
  // anything left besides count / agent / filler words → not a plain spawn
  const leftover = rest
    .replace(/\b\d+\b/g, ' ')
    .replace(found ? new RegExp(`\\b${found.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`) : /$^/, ' ')
    .replace(/\b(a|an|new|more|other|few|couple|of|several|some|agents?|consoles?|terminals?|instances?|sessions?|ones?|workers?|code|cli|with|the|another)\b/g, ' ')
    .trim()
  if (leftover) return null
  const label = agentLabel(agent)
  return {
    actions: [{ type: 'spawn', agent, count, team }],
    say: `Spawning ${count} ${label}${count === 1 ? '' : ' agents'}${team ? ` in ${team}` : ''}.`
  }
}

function ruleWorkspace(t: string): LocalPlan | null {
  const m = /^(?:new|create|add|open|make)(?: a| another)?(?: new)? (?:workspace|tab)(?: (?:called|named) (.+))?$/.exec(t)
  if (!m) return null
  return { actions: [{ type: 'newWorkspace', name: m[1] }], say: 'New workspace.' }
}

function rulePanel(t: string): LocalPlan | null {
  const m = /^(?:open|show|show me|go to|bring up|display|launch|pull up|view)\s+(?:the |my )?(.+?)(?:\s+(?:panel|studio|drawer|window|view))?$/.exec(t)
  if (!m) return null
  const asked = m[1] ?? ''
  const p = panelFor(asked)
  if (!p) return null
  return { actions: [{ type: 'openPanel', name: asked.replace(/^(the|my)\s+/, '') }], say: `Opening ${asked}.` }
}

function ruleZoom(t: string): LocalPlan | null {
  if (/^zoom (in|closer)$|^closer$|^bigger$/.test(t)) return { actions: [{ type: 'zoom', mode: 'in' }], say: '' }
  if (/^zoom (out|back)$|^further$|^smaller$/.test(t)) return { actions: [{ type: 'zoom', mode: 'out' }], say: '' }
  if (/^(fit|fit all|fit everything|fit (to )?(the )?(screen|board|view)|zoom to fit|show (me )?(everything|all|the whole board|the board)|overview|show all consoles|reset (the )?view)$/.test(t))
    return { actions: [{ type: 'zoom', mode: 'fit' }], say: '' }
  return null
}

function ruleFocus(t: string): LocalPlan | null {
  const m = /^(?:go to|focus(?: on)?|show me|jump to|take me to|find|zoom (?:in )?(?:on|to)|look at|where is|where's)\s+(.+)$/.exec(t)
  if (!m) return null
  const target = strip(m[1] ?? '')
  if (!resolveTeam(target) && !resolveRef(target).length) return null
  return { actions: [{ type: 'focus', target }], say: '' }
}

function rulePauseResume(t: string): LocalPlan | null {
  const m = /^(pause|freeze|hold|suspend|resume|unpause|un-pause|continue|unfreeze|wake up)\s+(.+)$/.exec(t)
  if (!m) return null
  const [, verb = '', whom = ''] = m
  const type = /^(pause|freeze|hold|suspend)$/.test(verb) ? 'pause' : 'resume'
  let list = splitList(whom.replace(/\b(agents?|consoles?|everything)\b$/, (w) => (w === 'everything' ? 'all' : '')).trim() || 'all')
  if (list.length === 1 && /^(all|everyone|everybody|all of them|the board)$/.test(list[0] ?? '')) list = ['all']
  const refs = refsOrNull(list)
  if (!refs) return null
  const ids = resolveRefs(refs).ids
  return { actions: [{ type, targets: refs }], say: `${type === 'pause' ? 'Pausing' : 'Resuming'} ${refs[0] === 'all' ? 'everyone' : namesOf(ids, 4)}.` }
}

function ruleTeamOps(t: string): LocalPlan | null {
  // delete the group called backend / delete backend group / remove team 2
  let m =
    /^(?:delete|remove|kill|close|destroy|get rid of)\s+(?:the\s+)?(?:group|team)\s+(?:called|named)?\s*(.+)$/.exec(t) ??
    /^(?:delete|remove|kill|close|destroy|get rid of)\s+(?:the\s+)?(.+?)\s+(?:group|team)$/.exec(t)
  if (m) {
    const which = m[1] ?? ''
    const g = resolveTeam(which) ?? resolveTeam(`group ${which}`)
    if (!g) return null
    return { actions: [{ type: 'deleteTeam', team: g.id }], say: `Deleting ${g.name}.` }
  }
  m = /^(?:ungroup|disband|dissolve|break up|split up)\s+(?:the\s+)?(?:(?:group|team)\s+)?(?:called\s+|named\s+)?(.+?)(?:\s+(?:group|team))?$/.exec(t)
  if (m) {
    const g = resolveTeam(m[1] ?? '')
    if (!g) return null
    return { actions: [{ type: 'ungroup', team: g.id }], say: `Ungrouped ${g.name}.` }
  }
  // put maya and rafa in a team called reviewers / group them as testers / group these / make a team called x with maya and rafa
  m = /^(?:group|team up|put|move|add|place)\s+(.+?)\s+(?:in|into|to|as|on)\s+(?:a\s+)?(?:new\s+)?(?:(?:team|group)\s*)?(?:(?:called|named)\s+)?(.*)$/.exec(t)
  let targets: string | undefined
  let name: string | undefined
  if (m) {
    targets = m[1]
    name = m[2]
  } else if ((m = /^(?:make|create|form|start)\s+(?:a\s+)?(?:new\s+)?(?:team|group)\s+(?:called|named)\s+(.+?)\s+(?:with|from|of)\s+(.+)$/.exec(t))) {
    name = m[1]
    targets = m[2]
  } else if ((m = /^(?:group|team up)\s+(.+)$/.exec(t))) {
    targets = m[1]
  } else return null
  name = (name ?? '').replace(/\s+(team|group)$/, '').trim()
  const list = splitList(targets!)
  const refs = refsOrNull(list, 'workspace')
  if (!refs) return null
  const ws = activeWs()
  const finalName = name || `Group ${(ws?.groups.length ?? 0) + 1}`
  return { actions: [{ type: 'group', targets: refs, name: finalName }], say: `Grouped as ${finalName}.` }
}

function ruleWire(t: string): LocalPlan | null {
  const hasOrch = /\borchestrat\w*/.test(t)
  const wireVerb = /\b(wire|wired|wires|connect|connected|link|linked|hook|attach|attached)\b/.test(t)
  if (!hasOrch && !wireVerb) return null
  // team references in the sentence
  const ws = activeWs()
  const teams = new Set<string>()
  for (const m of t.matchAll(/\b(?:group|team)\s*(\d+)\b/g)) {
    const g = resolveTeam(`group ${m[1]}`)
    if (g) teams.add(g.id)
  }
  for (const g of ws?.groups ?? []) {
    const n = g.name.toLowerCase()
    if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) teams.add(g.id)
  }
  if (/\b(all|every|each)\s+(the\s+)?(groups?|teams?)\b/.test(t)) ws?.groups.forEach((g) => teams.add(g.id))
  if (hasOrch) {
    if (!teams.size) {
      if (!/^(add|put|create|new|place|spawn|make|drop|give me|i need|i want)\b/.test(t) && !/^(an? )?(new )?orchestrator$/.test(t)) return null
      return { actions: [{ type: 'orchestrator' }], say: 'Orchestrator added.' }
    }
    return {
      actions: [...teams].map((id) => ({ type: 'wire', from: 'orchestrator', to: id }) as Action),
      say: `Orchestrator wired to ${[...teams].map((id) => ws!.groups.find((g) => g.id === id)!.name).join(' and ')}.`
    }
  }
  // connect maya to rafa
  const m = /^(?:wire|connect|link|hook up|attach)\s+(.+?)\s+(?:to|with|and)\s+(.+)$/.exec(t)
  if (!m) return null
  const a = strip(m[1] ?? '')
  const b = strip(m[2] ?? '')
  const okA = resolveTeam(a) || resolveRef(a, 'workspace').length === 1
  const okB = resolveTeam(b) || resolveRef(b, 'workspace').length === 1
  if (!okA || !okB) return null
  return { actions: [{ type: 'wire', from: a, to: b }], say: 'Wired.' }
}

function ruleHandoff(t: string): LocalPlan | null {
  const m = /^(?:pass|hand|give|handoff|hand off|transfer|move|send)\s+(?:(.+?)'s\s+)?(?:this|the|that|my|it|his|her|their)?\s*(?:task|work|job|session|conversation|context|it|this|over)?\s*(?:over\s+)?(?:from\s+(.+?)\s+)?(?:to|over to)\s+(?:a\s+)?(?:new\s+)?(.+?)(?:\s+(?:agent|console))?$/.exec(t)
  if (!m) return null
  if (/^(send)$/.test(t.split(' ')[0] ?? '') && !/\b(task|work|job|session|this|it)\b/.test(t)) return null
  const owner = m[1] ?? m[2]
  const target = strip(m[3] ?? '')
  const from = owner ? splitList(owner) : []
  if (from.length && !refsOrNull(from)) return null
  const agent = agentFromWord(target) ?? findAgentIn(target)?.id
  if (agent) {
    return {
      actions: [{ type: 'handoff', from, toAgent: agent }],
      say: `Handing off to ${agentLabel(agent)}.`
    }
  }
  const to = splitList(target)
  if (!refsOrNull(to)) return null
  return { actions: [{ type: 'handoff', from, to }], say: `Handing off to ${namesOf(resolveRefs(to).ids, 3)}.` }
}

function ruleKill(t: string): LocalPlan | null {
  const vm = VERB_KILL.exec(t)
  if (!vm) return null
  let rest = t.slice(vm[0].length).trim()
  if (!rest) return null
  if (/^(all|everything|everyone|everybody|all (the )?(agents|consoles|terminals)|the board)$/.test(rest)) rest = 'all'
  const list = splitList(rest)
  const refs = refsOrNull(list, 'workspace')
  if (!refs) return null
  return { actions: [{ type: 'kill', targets: refs }], say: '' }
}

function ruleTell(t: string, original: string): LocalPlan | null {
  const m = /^(?:tell|ask|have|get|make|instruct|order|remind|let)\s+(.+)$/.exec(t)
  if (!m) return null
  const rest = m[1] ?? ''
  // longest known addressee at the start
  const candidates = [
    'everyone', 'everybody', 'all agents', 'all consoles', 'all of them', 'all of you', 'the team', 'all', 'them', 'those', 'these',
    ...allConsoles().map((c) => c.data.name.toLowerCase()),
    ...(activeWs()?.groups ?? []).flatMap((g) => [`the ${g.name.toLowerCase()} group`, `the ${g.name.toLowerCase()} team`, `the ${g.name.toLowerCase()}`, g.name.toLowerCase()]),
    ...AGENTS.flatMap((a) => [`the ${a.id} agents`, `the ${a.id} consoles`, `all ${a.id}`, a.id])
  ].sort((a, b) => b.length - a.length)
  let who: string | null = null
  let body = ''
  // "maya and rafa to …"
  const listM = /^(.+?)\s+(?:to\s+)(.+)$/.exec(rest)
  if (listM) {
    const [, listWho = '', listBody = ''] = listM
    if (refsOrNull(splitList(listWho))) {
      who = listWho
      body = listBody
    }
  }
  if (!who) {
    for (const c of candidates) {
      if (rest === c || rest.startsWith(c + ' ')) {
        const after = rest.slice(c.length).trim()
        // "ask Maya what she's doing" is a question for the planner; "tell Maya the build broke" is a message
        if (m[0].split(' ')[0] !== 'tell' && !/^(to|,)\s/.test(after)) return null
        who = c
        body = after.replace(/^(to|that|,)\s+/, '').trim()
        break
      }
    }
  }
  if (!who || !body) return null
  const targets = /^(everyone|everybody|all agents|all consoles|all of them|all of you|the team|all)$/.test(who) ? ['all'] : splitList(who.replace(/^the\s+/, '').replace(/\s+(group|team)$/, ''))
  if (!refsOrNull(targets)) return null
  // keep the user's own casing for the message
  const idx = original.toLowerCase().lastIndexOf(body.slice(0, 12))
  const text = idx >= 0 ? original.slice(idx).replace(/[.]+$/, '') : body
  return { actions: [{ type: 'send', targets, text, submit: true }], say: '' }
}

const RULES: ((t: string, original: string) => LocalPlan | null)[] = [
  ruleWorkspace,
  ruleZoom,
  rulePanel,
  ruleHandoff,
  ruleWire,
  ruleTeamOps,
  ruleKill,
  rulePauseResume,
  ruleSpawn,
  ruleTell,
  ruleFocus
]

/** Try the local rules. Compound commands ("spawn 3 codex then group them as reviewers") work when every part does. */
export function parseLocal(text: string): LocalPlan | null {
  const parts = text
    .split(/\s*(?:,\s*)?\b(?:and then|then|after that|and also)\b\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
  const plans: LocalPlan[] = []
  for (const part of parts) {
    const t = normalize(part)
    if (!t) continue
    let got: LocalPlan | null = null
    for (const r of RULES) {
      got = r(t, part)
      if (got) break
    }
    if (!got) return null
    plans.push(got)
  }
  if (!plans.length) return null
  return { actions: plans.flatMap((p) => p.actions), say: plans.map((p) => p.say).filter(Boolean).join(' ') }
}

// ---------------------------------------------------------------- CLI planner

function snapshot() {
  const app = useApp.getState()
  const p = app.project!
  const ws = activeWs()
  const consoles = allConsoles().map((c) => {
    const team = c.groupId ? p.workspaces.find((w) => w.id === c.workspaceId)?.groups.find((g) => g.id === c.groupId)?.name : undefined
    return {
      id: c.id,
      name: c.data.name,
      agent: c.data.agentId,
      status: app.statuses[c.id] ?? (isLive(c.id) ? 'idle' : 'exited'),
      team,
      workspace: p.workspaces.find((w) => w.id === c.workspaceId)?.name,
      selected: app.selection.includes(c.id) || undefined
    }
  })
  const teams = (ws?.groups ?? []).map((g, i) => ({
    id: g.id,
    name: g.name,
    role: g.role,
    index: i + 1,
    members: ws!.nodes.filter((n) => n.groupId === g.id).map((n) => (n.data as any).name)
  }))
  const orchestrators = (ws?.nodes ?? []).filter((n) => n.type === 'orchestrator').map((n) => n.id)
  const installed = app.agents.filter((a) => a.path).map((a) => a.id)
  return {
    project: p.name,
    activeWorkspace: ws?.name,
    workspaces: p.workspaces.map((w) => w.name),
    consoles,
    teams,
    wires: (ws?.wires ?? []).map((w) => ({ from: w.from, to: w.to })),
    orchestrators,
    installedAgents: installed.length ? installed : AGENTS.map((a) => a.id),
    defaultAgent: app.settings.defaultAgent,
    current: currentConsole()
  }
}

/** The board-action schema, shared by the planner and Helm prompts. */
export const ACTION_SCHEMA = `Action schema (use console ids or exact console names, team ids or names):
- {"type":"spawn","agent":"<agent id>","count":N,"team":"<new or existing team name>?","role":"Frontend|Backend|Testers|Reviewers|Design|Docs|Security|General?","prompt":"<first message for each new console>?"}
- {"type":"send","targets":["<console/team/agent/'all'>"],"text":"<message typed into the console>","submit":true}
- {"type":"pause","targets":[...]} / {"type":"resume","targets":[...]} / {"type":"kill","targets":[...]}
- {"type":"group","targets":[...consoles],"name":"<team name>","role":"<role>"}
- {"type":"ungroup","team":"<team>"} / {"type":"deleteTeam","team":"<team>"}
- {"type":"orchestrator"} (adds an orchestrator node) / {"type":"wire","from":"orchestrator|<id/name>","to":"<team or console>"}
- {"type":"handoff","from":["<console>"],"toAgent":"<agent id>","note":"<extra instruction>?"}
- {"type":"openPanel","name":"missionMap|loops|memory|documents|diagrams|code|markdown|usage|settings|presets|composer|orchestrator|git|ci|accounts|skills|chat"}
- {"type":"focus","target":"<console or team>"} / {"type":"zoom","mode":"in|out|fit"} / {"type":"newWorkspace","name":"<name>?"}
- {"type":"say","text":"<answer>"} (for questions about the board; answer from the snapshot)`

function plannerPrompt(text: string): string {
  return `You are the planner of Fleetboard, a visual board of AI coding-agent terminals ("consoles").
Turn the user's spoken or typed request into board actions. Reply with ONLY a JSON object, no prose:
{"actions":[...],"say":"<one short spoken confirmation, under 15 words>"}

${ACTION_SCHEMA}

Rules:
- Do only what was asked. Never add kills, deletions or messages the user did not request.
- "them"/"those" means the consoles just created or selected; "this" means the "current" console.
- Messages to agents go in "send" with submit true; keep the user's wording.
- Only spawn installed agents. Prefer few actions. If the request is unclear, return no actions and ask in "say".

Board snapshot:
${JSON.stringify(snapshot())}

User request: ${JSON.stringify(text)}`
}

async function askPlanner(text: string): Promise<{ actions: Action[]; say: string } | null> {
  const app = useApp.getState()
  const project = app.project
  if (!project) return null
  const run = runCli({ prompt: plannerPrompt(text), cwd: project.path, agentId: app.settings.plannerAgent || undefined })
  let cancelled = false
  setVoice({
    phase: 'thinking',
    cancelThinking: () => {
      cancelled = true
      run.cancel()
      doneThinking()
    }
  })
  try {
    const res = await run.promise
    if (cancelled) return null
    const json = extractJson<any>(res.text)
    if (!json) {
      if (res.code !== 0) throw new Error(res.text.trim().split('\n').pop() || `planner exited with ${res.code}`)
      return { actions: [], say: res.text.trim().slice(0, 200) || "Sorry, I couldn't plan that." }
    }
    const list = Array.isArray(json) ? json : Array.isArray(json.actions) ? json.actions : []
    const actions = list.map(coerceAction).filter(Boolean) as Action[]
    return { actions, say: typeof json.say === 'string' ? json.say : '' }
  } finally {
    if (!cancelled) doneThinking()
  }
}

/** Leave the thinking state without clobbering a listen that started meanwhile. */
export function doneThinking() {
  setVoice(useVoice.getState().phase === 'thinking' ? { phase: 'idle', cancelThinking: null } : { cancelThinking: null })
}

// ---------------------------------------------------------------- run

const thread = () => useThread.getState()

/** Record a line in the thread, show it in the caption (unless something else shows it) and speak it. */
export function reply(text: string, caption = true) {
  if (!text) return
  thread().add('system', text)
  if (caption) showReply(text)
  speak(text)
}

const QUIET: Action['type'][] = ['zoom', 'focus', 'openPanel']

async function execute(actions: Action[], sayText: string) {
  beginPlanRun()
  const results: { ok: boolean; line: string }[] = []
  for (const a of actions) {
    if (a.type === 'say') continue
    try {
      results.push(await runAction(a))
    } catch (e: any) {
      results.push({ ok: false, line: `${describe(a)} failed: ${e?.message ?? e}` })
    }
  }
  for (const r of results) if (r.line) thread().add(r.ok ? 'system' : 'error', r.line)
  const sayActions = actions.flatMap((a) => (a.type === 'say' ? [a.text] : []))
  sayActions.forEach((x) => thread().add('system', x))
  const failures = results.filter((r) => !r.ok)
  const said = [sayText, ...sayActions].filter(Boolean).join(' ')
  const quiet = actions.every((a) => QUIET.includes(a.type))
  const spoken = failures[0]?.line ?? (said || (quiet ? '' : results[results.length - 1]?.line || 'Done.'))
  const caption = failures.length ? failures.map((r) => r.line).join(' · ') : said || results.map((r) => r.line).filter(Boolean).join(' · ')
  if (caption) showReply(caption)
  if (spoken) speak(spoken)
}

const CONFIRM_RE = /^(confirm|confirmed|yes|yeah|yep|yup|do it|go|go ahead|ok|okay|sure|proceed|affirmative|correct|confirm it)\b/
const CANCEL_RE = /^(cancel|no|nope|stop|never ?mind|abort|don'?t|wait|forget it|scratch that|not now)\b/

export async function confirmPending() {
  const p = useVoice.getState().pending
  if (!p) return
  setVoice({ pending: null })
  thread().add('system', 'Confirmed.')
  await execute(p.actions, p.say ?? '')
}

export function cancelPending() {
  if (!useVoice.getState().pending) return
  setVoice({ pending: null })
  reply('Cancelled.')
}

/** Run board actions, or park them behind a spoken / clicked confirm when they need one. */
export async function plan(actions: Action[], sayText: string, userText: string, fromPlanner: boolean) {
  if (!actions.length) {
    reply(sayText || "I'm not sure what to do with that.")
    return
  }
  const steps = actions.filter((a) => a.type !== 'say').map(describe)
  if (steps.length) thread().add('plan', `Plan · ${steps.join(' → ')}`)
  const reasons = confirmReasons(actions, userText, fromPlanner)
  if (reasons.length) {
    const prompt = confirmPrompt(actions)
    setVoice({ pending: { id: uid('plan'), actions, steps, prompt, say: sayText }, captionUntil: 0 })
    thread().add('system', prompt)
    speak(prompt)
    return
  }
  await execute(actions, sayText)
}

const SPOKEN_INDEX: Record<string, number> = { one: 0, first: 0, '1': 0, two: 1, second: 1, '2': 1, three: 2, third: 2, '3': 2, four: 3, fourth: 3, '4': 3 }

/** Which of the Inbox front card's buttons a short spoken answer means, if any. */
export function inboxPick(light: string): number | 'next' | null {
  const f = frontItem()
  if (!f) return null
  const t = light.replace(/\b(please|the|it|that)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^(next|skip|next one)$/.test(t)) return 'next'
  const m = /^(?:option|number|choice|answer)? ?(one|two|three|four|first|second|third|fourth|[1-4])(?: one)?$/.exec(t)
  const spokenAt = m ? SPOKEN_INDEX[m[1] ?? ''] : undefined
  if (spokenAt !== undefined && spokenAt < f.actions.length) return spokenAt
  const byLabel = f.actions.findIndex((a) => a.label.toLowerCase().replace(/[^a-z ]/g, '').trim() === t)
  if (byLabel >= 0) return byLabel
  if (f.kind === 'approval' || f.kind === 'ready') {
    if (/^(yes|yeah|yep|allow|approve|go ahead|do it|ok|okay|sure)$/.test(t)) {
      const p = f.actions.findIndex((a) => a.primary)
      return p >= 0 ? p : null
    }
    if (/^(no|nope|deny|reject|don't|do not)$/.test(t)) {
      const d = f.actions.findIndex((a) => a.tone === 'deny')
      return d >= 0 ? d : null
    }
  }
  return null
}

/** Entry point for the command bar, the chat drawer and push-to-talk. */
export async function runCommand(raw: string, source: Source) {
  const text = raw.trim()
  if (!text) return
  const app = useApp.getState()
  if (!app.project) return
  thread().add('user', text, source)
  setVoice({ transcript: text, reply: '', captionUntil: Date.now() + 8000 })
  const light = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()

  // 1. confirmation
  if (useVoice.getState().pending) {
    if (CONFIRM_RE.test(light)) return confirmPending()
    if (CANCEL_RE.test(light)) return cancelPending()
    setVoice({ pending: null })
    thread().add('system', 'Previous plan dropped.')
  }
  // "brainstorm X": straight to Oracle's panel, no routing round-trip
  const topic = brainstormTopic(text)
  if (topic) {
    if (useHelm.getState().card) dismissHelm()
    startBrainstorm(topic)
    reply(`Brainstorming ${topic} with a panel of three. Ideas land on the board.`)
    return
  }
  // spoken answers to the Inbox's front card: "allow", "deny", "merge", "option two", "next"
  if (source === 'voice' && !useHelm.getState().card) {
    const i = inboxPick(light)
    if (i === 'next') return cycleFront(1)
    const f = frontItem()
    const action = f && i != null ? f.actions[i] : undefined
    if (f && i != null && action) {
      showReply(`${action.label}.`, 1500)
      return runInboxAction(f, i)
    }
  }
  // a Helm card is up: "yes" / "the second one" picks, "no" dismisses, anything else replaces it
  if (useHelm.getState().card) {
    const pick = pickHelmOption(light)
    if (pick === 'dismiss') {
      dismissHelm()
      stopSpeaking()
      showReply('Okay.', 1500)
      return
    }
    if (pick != null) return runHelmOption(pick)
    dismissHelm()
  }
  if (/^(stop|stop talking|shut up|be quiet|quiet|silence|cancel|never ?mind)$/.test(light)) {
    stopSpeaking()
    useVoice.getState().cancelThinking?.()
    showReply('Okay.', 1500)
    return
  }

  // 2. dictation / direct orders: voice only types ("the Enter is yours"), typed @mentions submit
  const d = parseDictation(text)
  if (d) {
    const submit = source === 'typed'
    const { ids, missing } = resolveRefs(d.targets)
    if (ids.length) {
      const action: Action = { type: 'send', targets: d.targets, text: d.text, submit }
      if (ids.length > 6) return plan([action], '', text, false)
      const r = await runAction(action)
      thread().add(r.ok ? 'system' : 'error', r.line)
      showReply(submit ? r.line : `Typed into ${namesOf(ids, 4)} · the Enter is yours`)
      if (missing.length) app.toast(`No console matches ${missing.map((m) => '@' + m).join(', ')}`, 'warn')
      return
    }
    if (text.startsWith('@')) {
      reply(`No console matches ${d.targets.map((m) => '@' + m).join(', ')}.`)
      return
    }
  }

  // 3. local rules
  const local = parseLocal(text)
  if (local) return plan(local.actions, local.say, text, false)

  // 4. Helm reads the whole board and suggests the best route
  let helmFailed = false
  if (app.settings.helm !== false) {
    try {
      const res = await askHelm(text)
      if (!res) return // cancelled with the stop button
      showHelm(res, text, source)
      return
    } catch (e: any) {
      helmFailed = true
      thread().add('error', `Oracle couldn't plan that: ${e?.message ?? e}`)
    }
  }
  const board = looksLikeBoardCommand(text)
  if (helmFailed) app.toast(`Oracle couldn't plan that; sent it to the ${board ? 'planner' : 'Lead'}`, 'warn')

  // 5a. work for the team: anything that isn't about the board itself goes to the Lead
  if (!board) {
    try {
      const lead = await sendGoal(text)
      const line = lead && activeLead()?.id === lead.id ? `Sent to ${lead.name}.` : 'Started a Lead for this. It will plan, delegate and report back in your Inbox.'
      thread().add('system', line)
      showReply(line)
    } catch (e: any) {
      const msg = `Could not start the team: ${e?.message ?? e}`
      thread().add('error', msg)
      app.toast(msg, 'error')
    }
    return
  }

  // 5b. CLI planner for board commands the local rules didn't catch
  try {
    const res = await askPlanner(text)
    if (!res) return
    await plan(res.actions, res.say, text, true)
  } catch (e: any) {
    const msg = `Planner failed: ${e?.message ?? e}`
    thread().add('error', msg)
    showReply(msg)
    app.toast(msg, 'error')
  }
}

/** Speak + record a line from elsewhere (e.g. other features). */
export const announce = reply
