// Oracle's brainstorm: a panel of three agents with different angles (a pragmatist, a wild card and a
// critic), each run headless and read-only in the project, think about a topic in parallel. Oracle
// then merges duplicates and ranks what they came up with. Everything lives in one "brainstorm" node
// on the board, so the session is saved with the board and each idea keeps its buttons.
import { extractJson, invoke, runCli } from '../../lib/api'
import { allConsoles, useApp } from '../../state/store'
import { sendGoal } from '../../engine/fleet'

export type PersonaId = 'pragmatist' | 'wildcard' | 'critic'
export type Effort = 'S' | 'M' | 'L'

export interface Idea {
  id: string
  title: string
  pitch: string
  why?: string
  effort?: Effort
  /** 1-5 */
  impact?: number
  /** which panelists had it (several when Oracle merged duplicates) */
  from: PersonaId[]
  /** what the user did with it */
  done?: 'team' | 'plan' | 'deeper'
}

export interface Panelist {
  persona: PersonaId
  agentId: string
  state: 'thinking' | 'done' | 'failed'
  ms?: number
  count?: number
  error?: string
  /** the CLI that was picked first and couldn't run (this seat went to the planner's instead) */
  standInFor?: string
  /** why that one couldn't, in a few words */
  standInWhy?: string
}

export interface BrainstormData {
  topic: string
  status: 'running' | 'merging' | 'done' | 'failed'
  panel: Panelist[]
  ideas: Idea[]
  startedAt: number
  /** the brainstorm this one went deeper on */
  parentId?: string
  error?: string
}

export const PERSONAS: Record<PersonaId, { name: string; brief: string }> = {
  pragmatist: {
    name: 'Pragmatist',
    brief: 'You are the pragmatist. Ideas with the best value for the effort: concrete, specific to this project, shippable in days. Name the files or features they touch when you can.'
  },
  wildcard: {
    name: 'Wild card',
    brief: 'You are the wild card. Bold, unexpected, ambitious ideas: the 10x version, a different angle, something nobody asked for but would love. Ignore what seems hard; stay plausible for this project.'
  },
  critic: {
    name: 'Critic',
    brief: "You are the critic. Look for what is weak, missing, risky or annoying today about this, and turn each finding into an idea that fixes it. Be specific about the problem you're solving."
  }
}

const ORDER: PersonaId[] = ['pragmatist', 'wildcard', 'critic']
/** Different CLIs make for a more varied panel; these go first when installed. */
const PREFERRED = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'grok', 'crush', 'droid', 'amp', 'qwen']

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
let seq = 0
const ideaId = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`

/** Up to three installed headless CLIs, one per persona (the planner's own repeats when there are fewer). */
export function pickPanel(): Panelist[] {
  const app = useApp.getState()
  const installed = new Set(app.agents.filter((a) => a.path).map((a) => a.id))
  const planner = app.settings.plannerAgent || 'claude'
  const pool = [planner, ...PREFERRED.filter((id) => id !== planner)].filter((id) => installed.has(id))
  const agents = pool.length ? pool : [planner]
  return ORDER.map((persona, i) => ({ persona, agentId: agents[i % agents.length], state: 'thinking' as const }))
}

function panelPrompt(topic: string, persona: PersonaId, project: { name: string; path: string }, context: string): string {
  return `${PERSONAS[persona].brief}

You are one of three people brainstorming for the software project "${project.name}" (you are in its folder; skim README, PLAN.md, package.json or the main code if it helps, but change nothing and run nothing that writes).
${context ? `\nWhat is on the user's board right now:\n${context}\n` : ''}
Topic: ${JSON.stringify(topic)}

Come up with 4-6 distinct ideas from your angle. Reply with ONLY a JSON array, no prose, no code fences:
[{"title":"<at most 8 words>","pitch":"<1-2 sentences: what it is>","why":"<1 sentence: why it matters>","effort":"S|M|L","impact":<1-5>}]`
}

function mergePrompt(topic: string, all: { persona: PersonaId; ideas: any[] }[]): string {
  const list = all.flatMap(({ persona, ideas }) => ideas.map((i) => ({ from: persona, title: i.title, pitch: i.pitch, why: i.why, effort: i.effort, impact: i.impact })))
  return `You are Oracle. Three panelists brainstormed on: ${JSON.stringify(topic)}.
Merge ideas that are really the same (keep the best wording, list every panelist that had it in "from"), drop weak or vague ones, and rank the rest best first by value for the effort. Keep at most 10.
Reply with ONLY a JSON array, no prose, no code fences:
[{"title":"...","pitch":"...","why":"...","effort":"S|M|L","impact":1-5,"from":["pragmatist"|"wildcard"|"critic", ...]}]

Ideas:
${JSON.stringify(list)}`
}

export function coerceIdeas(raw: unknown, fallbackFrom?: PersonaId): Idea[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.ideas) ? (raw as any).ideas : []
  return arr
    .map((r: any): Idea | null => {
      const title = clip(r?.title, 80)
      const pitch = clip(r?.pitch ?? r?.description, 480)
      if (!title || !pitch) return null
      const effort = String(r?.effort ?? '').toUpperCase().charAt(0)
      const impact = Math.round(Number(r?.impact))
      const from = (Array.isArray(r?.from) ? r.from : fallbackFrom ? [fallbackFrom] : []).map((f: any) => String(f).toLowerCase().replace(/[^a-z]/g, '')).filter((f: string): f is PersonaId => ORDER.includes(f as PersonaId))
      return {
        id: ideaId(),
        title,
        pitch,
        why: r?.why ? clip(r.why, 200) : undefined,
        effort: (['S', 'M', 'L'] as const).find((e) => e === effort),
        impact: impact >= 1 && impact <= 5 ? impact : undefined,
        from: from.length ? [...new Set<PersonaId>(from)] : fallbackFrom ? [fallbackFrom] : []
      }
    })
    .filter(Boolean) as Idea[]
}

/** Without a merge pass: everything, roughly ranked (impact up, effort down). */
function localRank(ideas: Idea[]): Idea[] {
  const cost = { S: 1, M: 2, L: 3 }
  return [...ideas].sort((a, b) => (b.impact ?? 3) / cost[b.effort ?? 'M'] - (a.impact ?? 3) / cost[a.effort ?? 'M']).slice(0, 12)
}

/** A short view of the board for the panel: team goal, console names, notes and plan lines. */
function boardHint(): string {
  const p = useApp.getState().project
  if (!p) return ''
  const ws = p.workspaces.find((w) => w.id === p.activeWorkspaceId)
  const notes = (ws?.nodes ?? [])
    .filter((n) => n.type === 'note' || n.type === 'text')
    .map((n) => clip(n.data?.text, 120))
    .filter(Boolean)
    .slice(0, 6)
  const consoles = allConsoles().map((c) => c.data.name as string)
  return [consoles.length ? `consoles: ${consoles.join(', ')}` : '', notes.length ? `notes: ${notes.join(' | ')}` : ''].filter(Boolean).join('\n')
}

const BRAINSTORM_W = 760
const BRAINSTORM_H = 620

/** Start a brainstorm on the board. Returns the node id. */
export function startBrainstorm(topic: string, opts: { near?: string; parentId?: string } = {}): string | null {
  const app = useApp.getState()
  const project = app.project
  if (!project || !topic.trim()) return null
  const panel = pickPanel()
  const t = topic.trim()
  const data: BrainstormData = { topic: t.charAt(0).toUpperCase() + t.slice(1), status: 'running', panel, ideas: [], startedAt: Date.now(), parentId: opts.parentId }
  const ws = project.workspaces.find((w) => w.id === project.activeWorkspaceId)
  const near = opts.near ? ws?.nodes.find((n) => n.id === opts.near) : undefined
  const id = app.addNode({
    type: 'brainstorm',
    title: `Brainstorm · ${clip(topic, 48)}`,
    w: BRAINSTORM_W,
    h: BRAINSTORM_H,
    ...(near ? { x: near.x + near.w + 60, y: near.y } : {}),
    data
  })
  window.setTimeout(() => useApp.getState().focusItem(id), 60)
  void run(id, data.topic, panel, project)
  return id
}

const update = (id: string, patch: Partial<BrainstormData>) => useApp.getState().updateNodeData(id, patch)
const dataOf = (id: string): BrainstormData | undefined => {
  const p = useApp.getState().project
  for (const w of p?.workspaces ?? []) {
    const n = w.nodes.find((x) => x.id === id)
    if (n) return n.data as BrainstormData
  }
  return undefined
}

/** Brainstorms running in this window (a saved one that says "running" after a restart was cut off). */
const active = new Set<string>()
export const isRunning = (id: string) => active.has(id)

async function run(id: string, topic: string, panel: Panelist[], project: { name: string; path: string }) {
  active.add(id)
  try {
    await runPanel(id, topic, panel, project)
  } finally {
    active.delete(id)
  }
}

async function runPanel(id: string, topic: string, panel: Panelist[], project: { name: string; path: string }) {
  const context = boardHint()
  const planner = useApp.getState().settings.plannerAgent || 'claude'
  const ask = async (p: Panelist): Promise<{ ideas: Idea[]; error?: string }> => {
    try {
      const res = await runCli({ prompt: panelPrompt(topic, p.persona, project, context), cwd: project.path, agentId: p.agentId }).promise
      const ideas = coerceIdeas(extractJson(res.text), p.persona)
      if (ideas.length) return { ideas }
      return { ideas, error: res.code !== 0 ? lastLine(res.text) || `exited with ${res.code}` : 'no ideas in its reply' }
    } catch (e: any) {
      return { ideas: [], error: String(e?.message ?? e).slice(0, 200) }
    }
  }
  const results = await Promise.all(
    panel.map(async (p, i) => {
      const t0 = Date.now()
      let seat = p
      let r = await ask(seat)
      // a CLI that can't run here (signed out, folder not trusted, …): the planner's takes the seat
      if (!r.ideas.length && seat.agentId !== planner) {
        seat = { ...p, agentId: planner, standInFor: p.agentId, standInWhy: shortWhy(r.error) }
        setPanelist(id, i, seat)
        r = await ask(seat)
      }
      setPanelist(id, i, r.ideas.length ? { ...seat, state: 'done', ms: Date.now() - t0, count: r.ideas.length } : { ...seat, state: 'failed', ms: Date.now() - t0, error: r.error })
      return { persona: p.persona, ideas: r.ideas }
    })
  )
  const all = results.filter((r) => r.ideas.length)
  if (!all.length) return update(id, { status: 'failed', error: 'None of the panel came back with ideas. Check that your agent CLIs are signed in.' })
  update(id, { status: 'merging', ideas: localRank(all.flatMap((r) => r.ideas)) })
  try {
    const app = useApp.getState()
    const res = await runCli({ prompt: mergePrompt(topic, all), cwd: project.path, agentId: app.settings.plannerAgent || undefined }).promise
    const merged = coerceIdeas(extractJson(res.text))
    update(id, { status: 'done', ideas: merged.length ? merged.slice(0, 10) : localRank(all.flatMap((r) => r.ideas)) })
  } catch {
    update(id, { status: 'done' })
  }
  if (!document.hasFocus() && typeof Notification !== 'undefined') {
    try {
      new Notification('Brainstorm ready', { body: `${dataOf(id)?.ideas.length ?? 0} ideas on "${clip(topic, 60)}"` })
    } catch {
      /* notifications unavailable */
    }
  }
}

const lastLine = (t: string) => t.trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? ''

/** Why a CLI couldn't take part, in a few words. */
export function shortWhy(err?: string): string {
  const e = err ?? ''
  if (/401|unauthori[sz]ed|not (logged|signed) in|log ?in|api key|authenticat/i.test(e)) return 'not signed in'
  if (/trust/i.test(e)) return 'folder not trusted'
  if (/not found|ENOENT|not installed|on your PATH/i.test(e)) return 'not installed'
  if (/rate.?limit|quota|429|usage limit/i.test(e)) return 'over its limit'
  if (/timed? ?out/i.test(e)) return 'timed out'
  return 'could not run'
}

function setPanelist(id: string, i: number, p: Panelist) {
  const d = dataOf(id)
  if (!d) return
  const panel = d.panel.map((x, k) => (k === i ? p : x))
  update(id, { panel })
}

function markIdea(id: string, ideaIdx: string, patch: Partial<Idea> | null) {
  const d = dataOf(id)
  if (!d) return
  update(id, { ideas: patch === null ? d.ideas.filter((x) => x.id !== ideaIdx) : d.ideas.map((x) => (x.id === ideaIdx ? { ...x, ...patch } : x)) })
}

// ---------------------------------------------------------------- what an idea can become

export async function ideaToTeam(nodeId: string, idea: Idea) {
  const d = dataOf(nodeId)
  await sendGoal(`${idea.title}: ${idea.pitch}${idea.why ? ` (Why: ${idea.why})` : ''}${d ? ` This came out of a brainstorm on "${d.topic}".` : ''}`)
  markIdea(nodeId, idea.id, { done: 'team' })
}

/** Append it to PLAN.md (made if missing) under an "Ideas" heading. */
export async function ideaToPlan(nodeId: string, idea: Idea) {
  const app = useApp.getState()
  const root = app.project?.path
  if (!root) return
  const file = `${root}/PLAN.md`
  const exists = await invoke<boolean>('fs:exists', file)
  const original = exists ? await invoke<string>('fs:read', file) : null
  let text = original ?? '# Plan\n'
  const line = `- [ ] **${idea.title}**: ${idea.pitch}${idea.effort ? ` _(effort ${idea.effort})_` : ''}`
  if (!/^## Ideas\s*$/m.test(text)) text = text.replace(/\s*$/, '\n\n## Ideas\n')
  // after the last line of the Ideas section
  const lines = text.split('\n')
  const head = lines.findIndex((l) => /^## Ideas\s*$/.test(l))
  let at = head + 1
  while (at < lines.length && !/^#{1,2}\s/.test(lines[at])) at++
  while (at > head + 1 && !lines[at - 1].trim()) at--
  lines.splice(at, 0, line)
  // base: refuse if PLAN.md changed since we read it (an agent editing it right now)
  const r = await invoke<{ ok: boolean; reason?: string }>('fs:write', file, lines.join('\n').replace(/\n*$/, '\n'), original === null ? undefined : { base: original })
  if (r && r.ok === false) return app.toast('PLAN.md changed just now; try again', 'warn')
  markIdea(nodeId, idea.id, { done: 'plan' })
  app.toast(`Added to PLAN.md: ${idea.title}`, 'ok')
}

export function ideaDeeper(nodeId: string, idea: Idea) {
  markIdea(nodeId, idea.id, { done: 'deeper' })
  startBrainstorm(`${idea.title}: ${idea.pitch}`, { near: nodeId, parentId: nodeId })
}

export const dropIdea = (nodeId: string, idea: Idea) => markIdea(nodeId, idea.id, null)

/** A brainstorm card that has no topic yet (added by hand): give it one and start. */
export function startOn(nodeId: string, topic: string) {
  const project = useApp.getState().project
  const t = topic.trim()
  if (!project || !t) return
  const panel = pickPanel()
  useApp.getState().updateNode(nodeId, { title: `Brainstorm · ${clip(t, 48)}` })
  update(nodeId, { topic: t.charAt(0).toUpperCase() + t.slice(1), status: 'running', panel, ideas: [], startedAt: Date.now(), error: undefined })
  void run(nodeId, t, panel, project)
}

/** Run it again with a fresh panel (same topic). */
export function rerunBrainstorm(nodeId: string) {
  const d = dataOf(nodeId)
  const project = useApp.getState().project
  if (!d || !project) return
  const panel = pickPanel()
  update(nodeId, { status: 'running', panel, ideas: [], startedAt: Date.now(), error: undefined })
  void run(nodeId, d.topic, panel, project)
}

/** "brainstorm X", "let's brainstorm about X", "brainstorm ideas for X" → X */
export function brainstormTopic(text: string): string | null {
  const m = /^(?:let'?s\s+|can we\s+|please\s+)?brainstorm(?:\s+(?:about|on|ideas\s+(?:for|about|on)|some\s+ideas\s+(?:for|about|on)|ways\s+to))?[\s:,-]+(.{3,})$/i.exec(text.trim())
  return m ? m[1].trim().replace(/[?.!]+$/, '') : null
}
