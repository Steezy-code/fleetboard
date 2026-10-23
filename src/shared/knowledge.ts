// Repo knowledge: what Fleetboard has learned about one repo — how its checks run, who owns what, its
// house style, what "done" means there — so a charter can state a fact as known and cite it instead of
// guessing. The design calls this the project profile; it is not called that here because
// main/profiles.ts already means per-account CLI config directories.
//
// Pure — the main process and the renderer both import it. Every fact says where it came from, and
// only the code that did the finding may say so: `repo` is the main process's own read of the files,
// `you` is the user, and anything a model wrote is `readme` or `inferred`. A fact nobody can trace is
// one nobody can argue with, and a wrong one quietly degrades every charter built on it.
import type { Charter } from './charter'

/** Where a fact came from, in the order a rebuild respects: yours, then read, then the model's. */
export type Provenance = 'repo' | 'readme' | 'inferred' | 'you'
export type Topic = 'checks' | 'ownership' | 'style' | 'done' | 'layout'

export interface KnowledgeFact {
  /** `topic.slug`, the same on every rebuild that finds the same thing: what a rebuild and a citation match on */
  key: string
  topic: Topic
  text: string
  provenance: Provenance
  /** the repo-relative file or folder it was read or inferred from, forward slashes */
  source?: string
  /** for a check, the command that runs it */
  command?: string
  at: number
}

/**
 * One field of a charter the user changed before confirming it. Kept, shown, and read by nothing yet:
 * promoting a repeated correction into a fact needs either a model pass per correction or enough
 * structure to compare corrections across differently-worded goals, and this is the structure. Lists
 * are kept as what was added and removed, not before and after, so two corrections can be compared
 * entry by entry.
 */
export type CharterDelta = { at: number; request: string } & (
  | { field: 'understood' | 'doneWhen' | 'question'; before: string; after: string }
  | { field: 'wontTouch' | 'assumptions'; added: string[]; removed: string[] }
)

export interface RepoKnowledge {
  facts: KnowledgeFact[]
  /** keys the user deleted. Remembered so the repo, or a model, cannot simply re-assert what the user rejected */
  forgotten: string[]
  deltas: CharterDelta[]
  /** the last read of the repo's files */
  readAt?: number
  /** the last model pass */
  learnedAt?: number
}

export const TOPICS: Topic[] = ['checks', 'ownership', 'style', 'done', 'layout']
export const TOPIC_LABEL: Record<Topic, string> = { checks: 'Checks', ownership: 'Who owns what', style: 'House style', done: 'What done means', layout: 'Layout' }
export const PROVENANCE_LABEL: Record<Provenance, string> = { repo: 'read from the repo', readme: 'from the readme', inferred: 'inferred', you: 'from you' }

const PROVENANCES: Provenance[] = ['repo', 'readme', 'inferred', 'you']
/** what a rebuild may replace a held fact with: a model never outranks the files, and nothing outranks you */
const RANK: Record<Provenance, number> = { inferred: 0, readme: 0, repo: 1, you: 2 }
const MAX_FACTS = 120
const MAX_DELTAS = 200

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A path as the charter and merge gate compare it: repo-relative, forward slashes, no `./`. */
export const repoPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/')

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')

export const emptyKnowledge = (): RepoKnowledge => ({ facts: [], forgotten: [], deltas: [] })

function coerceFact(raw: unknown): KnowledgeFact | null {
  if (!isObj(raw)) return null
  const key = str(raw.key, 80)
  const topic = TOPICS.find((t) => t === raw.topic)
  const text = str(raw.text, 400)
  const provenance = PROVENANCES.find((p) => p === raw.provenance)
  if (!key || !topic || !text || !provenance) return null
  const source = str(raw.source, 200)
  const command = str(raw.command, 200)
  return { key, topic, text, provenance, ...(source ? { source } : {}), ...(command ? { command } : {}), at: Number.isFinite(raw.at) ? Number(raw.at) : 0 }
}

function coerceDelta(raw: unknown): CharterDelta | null {
  if (!isObj(raw) || !Number.isFinite(raw.at)) return null
  const head = { at: Number(raw.at), request: str(raw.request, 600) }
  if (raw.field === 'understood' || raw.field === 'doneWhen' || raw.field === 'question') {
    if (typeof raw.before !== 'string' || typeof raw.after !== 'string') return null
    return { ...head, field: raw.field, before: raw.before, after: raw.after }
  }
  if (raw.field === 'wontTouch' || raw.field === 'assumptions') {
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return { ...head, field: raw.field, added: list(raw.added), removed: list(raw.removed) }
  }
  return null
}

/**
 * The knowledge a board holds, whatever is on disk. A board saved before there was any, or one edited
 * by hand, has to open: what is usable is kept and the rest dropped.
 */
export function coerceKnowledge(raw: unknown): RepoKnowledge {
  if (!isObj(raw)) return emptyKnowledge()
  const facts = (Array.isArray(raw.facts) ? raw.facts : []).map(coerceFact).filter((f): f is KnowledgeFact => f !== null)
  const forgotten = Array.isArray(raw.forgotten) ? raw.forgotten.filter((k): k is string => typeof k === 'string') : []
  const deltas = (Array.isArray(raw.deltas) ? raw.deltas : []).map(coerceDelta).filter((d): d is CharterDelta => d !== null)
  const time = (v: unknown) => (Number.isFinite(v) ? { value: Number(v) } : null)
  const readAt = time(raw.readAt)
  const learnedAt = time(raw.learnedAt)
  return { facts, forgotten, deltas, ...(readAt ? { readAt: readAt.value } : {}), ...(learnedAt ? { learnedAt: learnedAt.value } : {}) }
}

/**
 * The facts a model pass wrote. Whatever provenance it claimed is ignored: it is `readme` when it names
 * one of the docs the inspection found (`docs`), and `inferred` otherwise. A model saying it read
 * something from the repo is precisely the claim this exists not to take on trust.
 */
export function coerceLearned(raw: unknown, docs: string[], at: number = Date.now()): KnowledgeFact[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.facts) ? raw.facts : []
  const known = new Set(docs.map(repoPath))
  const out: KnowledgeFact[] = []
  for (const r of list) {
    if (!isObj(r)) continue
    const topic = TOPICS.find((t) => t === str(r.topic, 20).toLowerCase())
    const text = str(r.text, 400)
    if (!topic || !text) continue
    const tail = slug(str(r.key, 80) || text)
    if (!tail) continue
    const source = repoPath(str(r.source, 200))
    const command = str(r.command, 200)
    const provenance: Provenance = r.fromReadme === true && source && known.has(source) ? 'readme' : 'inferred'
    out.push({ key: `${topic}.${tail}`, topic, text, provenance, ...(source ? { source } : {}), ...(command ? { command } : {}), at })
  }
  return out.slice(0, 24)
}

/**
 * A rebuild: the facts of the kinds in `replacing` are replaced by `fresh`, and every other fact is
 * left where it is. On a key both hold, the higher provenance stays (yours, then read, then the
 * model's), so a fact the user wrote or corrected is never overwritten; a key the user deleted is not
 * re-added at all.
 */
export function mergeFacts(k: RepoKnowledge, fresh: KnowledgeFact[], replacing: Provenance[]): RepoKnowledge {
  const forgotten = new Set(k.forgotten)
  const held = new Map<string, KnowledgeFact>()
  for (const f of k.facts) if (!replacing.includes(f.provenance) || f.provenance === 'you') held.set(f.key, f)
  for (const f of fresh) {
    if (forgotten.has(f.key) || f.provenance === 'you') continue
    const there = held.get(f.key)
    if (!there || RANK[f.provenance] > RANK[there.provenance]) held.set(f.key, f)
  }
  return { ...k, facts: [...held.values()].slice(0, MAX_FACTS) }
}

const replaceFact = (k: RepoKnowledge, key: string, f: (x: KnowledgeFact) => KnowledgeFact): RepoKnowledge => ({ ...k, facts: k.facts.map((x) => (x.key === key ? f(x) : x)) })

/** The user's correction. It becomes theirs, keeping its key and source, which is what makes every later rebuild leave it alone. */
export function editFact(k: RepoKnowledge, key: string, patch: { text?: string; command?: string }, at: number = Date.now()): RepoKnowledge {
  const text = patch.text === undefined ? undefined : str(patch.text, 400)
  if (text === '') return k
  const command = patch.command === undefined ? undefined : str(patch.command, 200)
  return replaceFact(k, key, (x) => {
    const { command: _old, ...rest } = x
    const cmd = command === undefined ? x.command : command
    return { ...rest, ...(text ? { text } : {}), ...(cmd ? { command: cmd } : {}), provenance: 'you', at }
  })
}

/** "This is right", for a fact a model inferred: until then it is shown but is not evidence. */
export const confirmFact = (k: RepoKnowledge, key: string, at: number = Date.now()) => replaceFact(k, key, (x) => ({ ...x, provenance: 'you', at }))

export function forgetFact(k: RepoKnowledge, key: string): RepoKnowledge {
  return { ...k, facts: k.facts.filter((f) => f.key !== key), forgotten: k.forgotten.includes(key) ? k.forgotten : [...k.forgotten, key] }
}

/** A fact the user writes from scratch, keyed so that nothing a rebuild finds can share its key. */
export function addFact(k: RepoKnowledge, topic: Topic, text: string, at: number = Date.now()): RepoKnowledge {
  const t = str(text, 400)
  if (!t) return k
  return { ...k, facts: [...k.facts, { key: `${topic}.you-${at}`, topic, text: t, provenance: 'you', at }] }
}

/**
 * A fact an assumption may rest on. Not an inferred one: that is a model's guess, and letting a charter
 * cite it as known would launder the guess into confidence through the panel — the user confirms it
 * first, and it is then theirs.
 */
export const citable = (k: RepoKnowledge, key: string): KnowledgeFact | undefined => k.facts.find((f) => f.key === key && f.provenance !== 'inferred')

const line = (f: KnowledgeFact) =>
  `- fact:${f.key} (${PROVENANCE_LABEL[f.provenance]}${f.source ? `, ${f.source}` : ''}${f.provenance === 'inferred' ? ' — not evidence until the user confirms it' : ''}): ${f.text}${f.command && !f.text.includes(f.command) ? ` [\`${f.command}\`]` : ''}`

/**
 * The facts as a model is shown them, each with the key it cites them by. Citable facts first, so a
 * list cut to fit keeps the ones a charter can rest on.
 */
export function knowledgeBlock(k: RepoKnowledge, max = 2500): string {
  const ordered = [...k.facts].sort((a, b) => RANK[b.provenance] - RANK[a.provenance])
  const out: string[] = []
  let used = 0
  for (const f of ordered) {
    const l = line(f)
    if (used + l.length + 1 > max) break
    out.push(l)
    used += l.length + 1
  }
  return out.join('\n')
}

/** What the user changed on a charter between the gate showing it and their confirming it, a field at a time. */
export function charterDeltas(drafted: Charter, confirmed: Charter, at: number = Date.now()): CharterDelta[] {
  const head = { at, request: confirmed.request }
  const out: CharterDelta[] = []
  const text = (field: 'understood' | 'doneWhen' | 'question', before: string, after: string) => before !== after && out.push({ ...head, field, before, after })
  const list = (field: 'wontTouch' | 'assumptions', before: string[], after: string[]) => {
    const added = after.filter((x) => !before.includes(x))
    const removed = before.filter((x) => !after.includes(x))
    if (added.length || removed.length) out.push({ ...head, field, added, removed })
  }
  text('understood', drafted.understood, confirmed.understood)
  list(
    'assumptions',
    drafted.assumptions.map((a) => a.text),
    confirmed.assumptions.map((a) => a.text)
  )
  list('wontTouch', drafted.wontTouch, confirmed.wontTouch)
  text('doneWhen', drafted.doneWhen, confirmed.doneWhen)
  text('question', drafted.question?.text ?? '', confirmed.question?.text ?? '')
  return out
}

export function withDeltas(k: RepoKnowledge, deltas: CharterDelta[]): RepoKnowledge {
  return deltas.length ? { ...k, deltas: [...k.deltas, ...deltas].slice(-MAX_DELTAS) } : k
}
