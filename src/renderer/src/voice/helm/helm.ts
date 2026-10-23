// Helm: the command bar's smart mode. Reads the whole board (helm/context.ts), asks the planner CLI
// for a short answer plus 1-3 one-click routes (playbook, team goal, message to a console, board
// actions, a panel), and runs the one the user picks. The card itself is HelmCard.tsx.
import { create } from 'zustand'
import { coerceCharter } from '@shared/charter'
import { allConsoles, useApp } from '../../state/store'
import { extractJson, runCli, uid } from '../../lib/api'
import { activeLead, sendGoal } from '../../engine/fleet'
import { playbookById } from '../../playbooks/catalog'
import { runPlaybook } from '../../playbooks/run'
import { type Action, coerceAction, describe, resolveRefs } from '../actions'
import { setVoice, useThread } from '../thread'
import { ACTION_SCHEMA, doneThinking, plan, reply, type Source } from '../planner'
import { boardContext, playbookCatalog } from './context'
import { ciItems, fixCi, useCi } from '../../workbench/ciStore'
import { autoApproves, routeFeedback, useFeedback } from '../../workbench/prFeedback'
import { startBrainstorm } from './brainstorm'
import { CHARTER_FIELDS } from '../../fleet/charter'

// ---------------------------------------------------------------- types / store

export type HelmKind = 'playbook' | 'team' | 'send' | 'actions' | 'answer' | 'panel' | 'github' | 'brainstorm'

export interface HelmOption {
  label: string
  detail: string
  kind: HelmKind
  playbook?: { id: string; inputs: Record<string, string> }
  goal?: string
  targets?: string[]
  text?: string
  submit?: boolean
  actions?: Action[]
  panel?: string
  /** fix a red CI run / give a PR's review comments to its agent; target is "branch" or "pr:<number>" */
  github?: { do: 'fix-ci' | 'send-feedback'; target: string }
  /** what a brainstorm panel should think about */
  topic?: string
  /** a team option's charter as the model wrote it; coerced where it is used, so a bad one costs confidence and not the goal */
  charter?: unknown
}

export interface HelmResult {
  reply: string
  options: HelmOption[]
  auto: number | null
}

export interface HelmCardData {
  id: string
  request: string
  source: Source
  reply: string
  options: HelmOption[]
  /** index of the option that already ran (auto) */
  ran: number | null
}

interface HelmState {
  card: HelmCardData | null
  /** Helm is reading the board / waiting for the CLI */
  thinking: boolean
  /** text the command bar should take back ("Edit"); n bumps on every request */
  draft: { text: string; n: number } | null
}

export const useHelm = create<HelmState>(() => ({ card: null, thinking: false, draft: null }))

export const dismissHelm = () => useHelm.setState({ card: null })

export const HELM_PANELS = ['ci', 'missionMap', 'loops', 'memory', 'knowledge', 'documents', 'diagrams', 'code', 'markdown', 'usage', 'settings', 'sweep', 'presets', 'git', 'chat', 'orchestrator', 'accounts', 'skills', 'journal']

/** Read-only playbooks Helm may start without a click. */
// only what starts no agents: the PR review and database playbooks are review-only in what they ask
// for, but each starts a Lead and reviewers, which spends and puts a charter in front of the user
const AUTO_PLAYBOOKS = ['morning-sweep']

// ---------------------------------------------------------------- prompt

export function helmPrompt(text: string, board: string): string {
  return `You are Oracle, the router of Fleetboard: a visual board of real AI coding-agent terminals ("consoles": Claude Code, Codex, ...) where a Lead agent can plan work and run workers in git worktrees.
The user typed or said a request. Read the board snapshot, then answer and/or suggest the 1-3 best routes, best first.
Reply with ONLY a JSON object, no prose, no code fences:
{"reply":"<1-2 short sentences, spoken style>","options":[...],"auto":null}

Option shapes ("label": button text, 2-5 words; "detail": one line on what it does and why):
- {"kind":"playbook","label":"...","detail":"...","playbook":{"id":"<playbook id>","inputs":{"<key>":"<value>"}}}  run a playbook; fill its inputs from the request in the user's own words; leave out required inputs you can't fill (the user is asked).
- {"kind":"team","label":"...","detail":"...","goal":"<clear, self-contained goal for the Lead>","charter":{<the charter, below>}}  custom multi-step work that no playbook fits; goes to the active lead if there is one, otherwise starts a new Lead.
- {"kind":"send","label":"...","detail":"...","targets":["<exact console name>"],"text":"<message typed into that console>","submit":true}  message an agent already on the board; submit false only types it (the user presses Enter).
- {"kind":"actions","label":"...","detail":"...","actions":[<board actions>]}  board operations (schema below).
- {"kind":"github","label":"...","detail":"...","github":{"do":"fix-ci","target":"branch|pr:<number>"}}  send an agent to fix a red CI run on this branch or on a PR, with the failed log (a PR's own agent gets it when it has one).
- {"kind":"github","label":"...","detail":"...","github":{"do":"send-feedback","target":"pr:<number>"}}  give a PR's review comments to the agent that made it (or a new console in that branch).
- {"kind":"brainstorm","label":"...","detail":"...","topic":"<the question to brainstorm, self-contained>"}  three agents (a pragmatist, a wild card, a critic) brainstorm it in parallel; Oracle merges and ranks the ideas on the board.
- {"kind":"panel","label":"...","detail":"...","panel":"ci|missionMap|loops|memory|knowledge|documents|diagrams|code|markdown|usage|settings|sweep|presets|git|chat|orchestrator"}  (ci = the CI & reviews drawer; knowledge = what Fleetboard knows about this repo, where each fact came from, and the user's edits to charters)
- {"kind":"answer"}  no button: the answer is the reply itself.

${ACTION_SCHEMA}

Charter, for a team option: what you understood the job to be, which the user confirms before any agent starts. Look in the repo only as far as the request needs; what is already known about it is under KNOWN ABOUT THIS REPO in the snapshot.
${CHARTER_FIELDS}

Rules:
- reply: plain spoken English, no markdown, lists, ids or file dumps. Say what you found or what you suggest.
- Questions about the board, the team or the work ("who needs me?", "what is Maya doing?", "did the tests pass?") → answer directly in "reply" from the snapshot (console output, statuses, plan, questions); options empty or one useful follow-up.
- CI, PRs and reviews ("is CI green?", "any review comments?", "why is the build red?") → answer from CI AND PULL REQUESTS; offer a "github" option when something is red or has unsent comments.
- "What should I work on?" / "what needs me?" → weigh, in order: questions waiting for the user, red CI, review comments not yet sent, changes requested, approved PRs to merge, PRs waiting on review, then OTHER REPOS from the morning sweep and the next plan item. Name the top 2-3 concretely, and give each one you can act on as an option (a "github" option for red CI or unsent review comments).
- Open-ended "what could we…", "ideas for…", "how might we…", "what should this become" → offer a "brainstorm" option first (often with a playbook or team option as the alternative).
- Prefer a playbook when one fits. Prefer "send" to an existing console when an agent on the board is already working on that thing or owns that area. Use "team" for custom multi-step work no playbook fits.
- Only use console names, playbook ids and panels that exist. Never add kill/close/delete steps the user did not ask for.
- At most 3 options, best first, each meaningfully different. Leave options empty when the reply fully answers.
- "auto": the index of the option to run right away, ONLY when the request is unambiguous AND that option only shows something (a panel) or is the morning-sweep playbook (it starts no agents). Never auto for a send or any other playbook. Never auto for kill/close/merge, team or feature work. Otherwise null.

Playbooks (id · name · when to use · inputs; "?" = optional):
${playbookCatalog()}

Board snapshot:
${board}

User request: ${JSON.stringify(text)}`
}

// ---------------------------------------------------------------- validation

const str = (v: any, n = 2000) => (typeof v === 'string' ? v.trim().slice(0, n) : v == null ? '' : String(v).trim().slice(0, n))
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const KINDS: HelmKind[] = ['playbook', 'team', 'send', 'actions', 'answer', 'panel', 'github', 'brainstorm']

function coerceOption(raw: any): HelmOption | null {
  if (!raw || typeof raw !== 'object') return null
  let kind = str(raw.kind).toLowerCase() as HelmKind
  if (!KINDS.includes(kind)) {
    kind = raw.github ? 'github' : raw.topic ? 'brainstorm' : raw.playbook ? 'playbook' : raw.goal ? 'team' : raw.text && raw.targets ? 'send' : Array.isArray(raw.actions) ? 'actions' : raw.panel ? 'panel' : 'answer'
  }
  const label = clip(str(raw.label, 200), 48)
  const detail = clip(str(raw.detail, 400), 140)
  switch (kind) {
    case 'playbook': {
      const id = str(typeof raw.playbook === 'string' ? raw.playbook : raw.playbook?.id ?? raw.id)
      const pb = playbookById(id)
      if (!pb) return null
      const given = raw.playbook?.inputs ?? raw.inputs ?? {}
      const inputs: Record<string, string> = {}
      for (const i of pb.inputs) {
        const v = given?.[i.key]
        if (v != null && v !== '') inputs[i.key] = typeof v === 'boolean' ? (v ? '1' : '') : str(v)
      }
      return { kind, label: label || pb.name, detail: detail || pb.blurb, playbook: { id: pb.id, inputs } }
    }
    case 'team': {
      const goal = str(raw.goal ?? raw.text, 4000)
      if (!goal) return null
      const charter = raw.charter && typeof raw.charter === 'object' && !Array.isArray(raw.charter) ? { charter: raw.charter } : {}
      return { kind, label: label || 'Give it to the team', detail: detail || clip(goal, 140), goal, ...charter }
    }
    case 'send': {
      const targets = (Array.isArray(raw.targets) ? raw.targets : raw.targets ? [raw.targets] : []).map((t: any) => str(t, 80)).filter(Boolean)
      const text = str(raw.text, 4000)
      if (!targets.length || !text) return null
      const { ids } = resolveRefs(targets)
      if (!ids.length) return null
      const submit = raw.submit !== false
      return { kind, label: label || `Message ${targets.join(', ')}`, detail: detail || clip(text, 140), targets, text, submit }
    }
    case 'actions': {
      const list = (Array.isArray(raw.actions) ? raw.actions : []).map(coerceAction).filter(Boolean) as Action[]
      if (!list.some((a) => a.type !== 'say')) return null
      const steps = list.filter((a) => a.type !== 'say').map(describe).join(' → ')
      return { kind, label: label || 'Do it on the board', detail: detail || clip(steps, 140), actions: list }
    }
    case 'panel': {
      const want = str(raw.panel ?? raw.name).replace(/\s+/g, '')
      const panel = HELM_PANELS.find((p) => p.toLowerCase() === want.toLowerCase())
      if (!panel) return null
      return { kind, label: label || `Open ${panel}`, detail, panel }
    }
    case 'github': {
      const g = raw.github ?? {}
      const what = str(g.do).toLowerCase()
      const target = str(g.target ?? g.pr ?? 'branch').toLowerCase().replace(/^#/, 'pr:').replace(/^(\d+)$/, 'pr:$1')
      if (what !== 'fix-ci' && what !== 'send-feedback') return null
      if (!githubTarget(what, target)) return null
      const fallback = what === 'fix-ci' ? (target === 'branch' ? 'Fix CI' : `Fix CI on PR #${target.slice(3)}`) : `Send PR #${target.slice(3)} comments`
      return { kind, label: label || fallback, detail, github: { do: what, target } }
    }
    case 'brainstorm': {
      const topic = str(raw.topic ?? raw.text ?? raw.goal, 400)
      if (!topic) return null
      return { kind, label: label || 'Brainstorm it', detail: detail || `A panel of three thinks about: ${clip(topic, 100)}`, topic }
    }
    case 'answer':
      return { kind, label, detail }
  }
}

/** The CI item or PR an option points at, when it (still) exists. */
function githubTarget(what: string, target: string) {
  if (what === 'fix-ci') {
    const items = ciItems(useCi.getState().status).filter((i) => i.state === 'failing')
    return target === 'branch' ? items.find((i) => i.run) : items.find((i) => i.key === target)
  }
  const fb = useFeedback.getState().result
  const n = Number(target.replace(/^pr:/, ''))
  return fb?.ok ? fb.prs.find((p) => p.number === n && p.comments.length) : undefined
}

/** Can this option run without a click? (enforced here, whatever the model said) */
export function autoSafe(o: HelmOption): boolean {
  if (o.kind === 'panel') return true
  // not even a message left unsent: Oracle's words come from a snapshot that holds other people's
  // text, and a typed draft is submitted by the next Enter anything presses in that console
  if (o.kind === 'playbook') return AUTO_PLAYBOOKS.includes(o.playbook!.id) && !missingInputs(o).length
  return false
}

export function coerceResult(json: any): HelmResult {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('reply was not a JSON object')
  const all = (Array.isArray(json.options) ? json.options : []).map(coerceOption).filter(Boolean) as HelmOption[]
  let replyText = str(json.reply ?? json.say ?? json.answer, 600)
  // answers are text, not buttons
  if (!replyText) replyText = all.find((o) => o.kind === 'answer' && (o.detail || o.label))?.detail || ''
  const options = all.filter((o) => o.kind !== 'answer').slice(0, 3)
  if (!replyText && !options.length) throw new Error('no reply and no usable options')
  const a = json.auto
  // the model may name an option to run on its own; only an option that exists and is safe to
  let auto: number | null = null
  if (typeof a === 'number' && Number.isInteger(a) && a >= 0) {
    const candidate = options[a]
    if (candidate && autoSafe(candidate)) auto = a
  }
  return { reply: replyText, options, auto }
}

// ---------------------------------------------------------------- ask

/** Ask Helm about a request. Null when cancelled (stop button / "stop"); throws when it can't plan. */
export async function askHelm(text: string): Promise<HelmResult | null> {
  const app = useApp.getState()
  const project = app.project
  if (!project) return null
  let cancelled = false
  let run: ReturnType<typeof runCli> | null = null
  const finish = () => {
    useHelm.setState({ thinking: false })
    doneThinking()
  }
  useHelm.setState({ thinking: true })
  setVoice({
    phase: 'thinking',
    cancelThinking: () => {
      cancelled = true
      run?.cancel()
      finish()
    }
  })
  try {
    const board = await boardContext(() => cancelled)
    if (cancelled) return null
    run = runCli({ prompt: helmPrompt(text, board), cwd: project.path, agentId: app.settings.plannerAgent || undefined })
    const res = await run.promise
    if (cancelled) return null
    const json = extractJson<any>(res.text)
    if (!json) {
      if (res.code !== 0) throw new Error(res.text.trim().split('\n').pop() || `planner exited with ${res.code}`)
      throw new Error('no JSON in the reply')
    }
    return coerceResult(json)
  } catch (e) {
    if (cancelled) return null
    throw e
  } finally {
    if (!cancelled) finish()
  }
}

// ---------------------------------------------------------------- show / pick

const thread = () => useThread.getState()

/** Show Helm's answer: speak it, record it, put the card up, auto-run when allowed. */
export function showHelm(res: HelmResult, request: string, source: Source) {
  // the card shows the request and the reply; the caption steps aside
  setVoice({ captionUntil: 0 })
  reply(res.reply, false)
  if (res.options.length) thread().add('plan', `Oracle suggests · ${res.options.map((o, i) => `${i + 1}. ${o.label}`).join(' · ')}`)
  const card: HelmCardData = { id: uid('helm'), request, source, reply: res.reply, options: res.options, ran: null }
  useHelm.setState({ card })
  if (res.auto != null) {
    useHelm.setState({ card: { ...card, ran: res.auto } })
    const o = res.options[res.auto]
    if (o) {
      thread().add('plan', `Oracle → ${o.label} (ran automatically)`)
      void execOption(o, request)
    }
  }
}

/** First option that hasn't run yet. */
export function primaryIndex(card: HelmCardData | null = useHelm.getState().card): number | null {
  if (!card) return null
  const i = card.options.findIndex((_, k) => k !== card.ran)
  return i < 0 ? null : i
}

const ORDINALS: Record<string, number> = { '1': 0, one: 0, first: 0, '2': 1, two: 1, second: 1, '3': 2, three: 2, third: 2 }

/** Spoken / typed follow-up while a card is up: an option index, 'dismiss', or null (a new request). */
export function pickHelmOption(light: string): number | 'dismiss' | null {
  const card = useHelm.getState().card
  if (!card) return null
  const t = light.trim()
  if (/^(no|nope|cancel|never ?mind|dismiss|forget it|not now|none|none of them|close|close it)$/.test(t)) return 'dismiss'
  if (/^(yes|yeah|yep|yup|do it|go|go ahead|ok|okay|sure|run it|do that|sounds good|confirm|that one|the first one please)( please)?$/.test(t)) return primaryIndex(card)
  const m = /^(?:(?:do|run|pick|choose|take|use|go with|try)\s+)?(?:the\s+)?(?:option\s+|number\s+)?(1|2|3|one|two|three|first|second|third|last)(?:\s+one)?(?:\s+please)?$/.exec(t)
  if (m) {
    const said = m[1] ?? ''
    const i = said === 'last' ? card.options.length - 1 : ORDINALS[said]
    return i != null && i < card.options.length ? i : null
  }
  return null
}

export function missingInputs(o: HelmOption) {
  const pb = o.playbook ? playbookById(o.playbook.id) : undefined
  if (!pb || pb.panel) return []
  return pb.inputs.filter((i) => !i.optional && i.kind !== 'switch' && !(o.playbook!.inputs[i.key] ?? i.value ?? '').trim())
}

/** Click on an option (or Enter / "yes" for the primary). */
export async function runHelmOption(i: number | null = primaryIndex()) {
  const card = useHelm.getState().card
  if (!card || i == null) return
  const o = card.options[i]
  if (!o) return
  dismissHelm()
  thread().add('plan', `Oracle → ${o.label}`)
  await execOption(o, card.request)
}

/**
 * Oracle's words are about to be submitted into a console that acts on them without a model or a
 * person in between: a shell or command console (it runs the line), or an agent that approves its
 * own prompts. Those are asked about with the text in full, whatever the card said.
 */
async function mayRunIn(actions: Action[]): Promise<boolean> {
  const risky = new Set<string>()
  let text = ''
  for (const a of actions) {
    if (a.type !== 'send' || !a.submit) continue
    for (const id of resolveRefs(a.targets).ids) {
      const c = allConsoles().find((x) => x.id === id)
      if (!c) continue
      if (c.data.agentId === 'shell' || c.data.command || autoApproves(id)) {
        risky.add(String(c.data.name ?? id))
        text ||= a.text
      }
    }
  }
  if (!risky.size) return true
  const names = [...risky]
  return useApp.getState().confirm({
    title: `Send this to ${names.join(', ')}?`,
    body: `${names.length === 1 ? 'It runs' : 'They run'} what it is sent without asking: “${text.length > 300 ? text.slice(0, 299) + '…' : text}”`,
    confirm: 'Send',
    danger: true
  })
}

async function execOption(o: HelmOption, request: string) {
  const app = useApp.getState()
  try {
    switch (o.kind) {
      case 'playbook': {
        const pb = playbookById(o.playbook!.id)!
        const missing = missingInputs(o)
        if (missing.length) {
          app.openPanel('presets', { playbook: pb.id, inputs: o.playbook!.inputs })
          const line = `${pb.name}: fill in ${missing.map((m) => m.label.replace(/\?$/, '').toLowerCase()).join(', ')} to start.`
          thread().add('system', line)
          setVoice({ reply: line, captionUntil: Date.now() + 5000 })
          return
        }
        const lead = await runPlaybook(pb.id, o.playbook!.inputs)
        if (!lead && !pb.panel) return // dismissed at the gate, or the folder was declined: nothing opened or started
        const line = lead ? `${pb.name}: ${lead.name} is on it. Results land in your Inbox.` : `Opened ${pb.name}.`
        reply(line)
        return
      }
      case 'team': {
        // the charter rode Oracle's own reply; a missing or unusable one is a low-confidence charter, not a second model call
        const lead = await sendGoal(o.goal!, coerceCharter(o.charter, request))
        if (!lead) return // dismissed at the gate (or the folder was declined): nothing started, so nothing to report
        const line = activeLead()?.id === lead.id ? `Sent to ${lead.name}.` : 'Started a Lead for this. It will plan, delegate and report back in your Inbox.'
        thread().add('system', line)
        setVoice({ reply: line, captionUntil: Date.now() + 6000 })
        return
      }
      case 'send': {
        const send: Action = { type: 'send', targets: o.targets!, text: o.text!, submit: o.submit !== false }
        if (!(await mayRunIn([send]))) return
        return await plan([send], '', request, false)
      }
      case 'actions':
        if (!(await mayRunIn(o.actions!))) return
        return await plan(o.actions!, '', request, false)
      case 'panel':
        return await plan([{ type: 'openPanel', name: o.panel! }], '', request, false)
      case 'brainstorm': {
        startBrainstorm(o.topic!)
        reply(`Brainstorming with a panel of three. Ideas land on the board.`)
        return
      }
      case 'github': {
        const t = githubTarget(o.github!.do, o.github!.target)
        if (!t) throw new Error('that is no longer red or waiting')
        if (o.github!.do === 'fix-ci') await fixCi(t as ReturnType<typeof ciItems>[number])
        else await routeFeedback(t as any)
        return
      }
      case 'answer':
        return
    }
  } catch (e: any) {
    const msg = `${o.label} failed: ${e?.message ?? e}`
    thread().add('error', msg)
    app.toast(msg, 'error')
  }
}

/** "Edit": put the option's goal / message (or the request) back in the command bar. */
export function editHelmOption(i: number | null = primaryIndex()) {
  const card = useHelm.getState().card
  if (!card) return
  const o = i == null ? undefined : card.options[i]
  let text = card.request
  if (o?.kind === 'team' && o.goal) text = o.goal
  else if (o?.kind === 'send' && o.text) text = `${o.targets!.map((t) => '@' + t.replace(/\s+/g, '')).join(' ')} ${o.text}`
  dismissHelm()
  useHelm.setState((s) => ({ draft: { text, n: (s.draft?.n ?? 0) + 1 } }))
}

