// The board's side of repo knowledge (shared/knowledge.ts): kept in the project's own state, so it is
// saved, snapshotted and recovered with the board and an older board simply has none. Built from the
// main process's free read of the repo, refreshed whenever it is a few minutes old, and from one model
// pass that runs only when the user asks for it: a goal never waits on a model to learn the repo.
import type { Charter } from '@shared/charter'
import { type RepoKnowledge, type RepoReading, charterDeltas, coerceKnowledge, coerceLearned, emptyKnowledge, knowledgeBlock, mergeFacts, withDeltas } from '@shared/knowledge'
import { useApp } from '../state/store'
import { extractJson, invoke, runCli } from '../lib/api'
import { readOnlyAgent } from '@shared/agents'

/** Older than this, the next reader reads the repo again. The read is free; this only spares a busy board the churn. */
export const READ_EVERY_MS = 5 * 60_000
/** The read is a handful of small files. One that takes longer than this is not waited for: the gate goes on with what is known. */
export const READ_TIMEOUT_MS = 2_500
/** A model pass reads the repo and can take a while; one that never answers has no exit of its own. */
export const LEARN_TIMEOUT_MS = 180_000

export const currentKnowledge = (): RepoKnowledge => coerceKnowledge(useApp.getState().project?.extras.knowledge)

/**
 * The only way knowledge reaches the board. `projectId` is the board the work started on: a read or a
 * model pass can outlast a switch of project, and its result belongs to the repo it read, not to
 * whichever board is open when it lands.
 */
function write(projectId: string, next: RepoKnowledge): boolean {
  const app = useApp.getState()
  if (app.project?.id !== projectId) return false
  app.setProjectExtra('knowledge', next)
  return true
}

/** The user's own change, from the panel. */
export function changeKnowledge(f: (k: RepoKnowledge) => RepoKnowledge) {
  const p = useApp.getState().project
  if (p) write(p.id, f(currentKnowledge()))
}

/** When each board's repo was last read. Not saved: it says how fresh this session's read is, which a reopened board has not had. */
const lastRead = new Map<string, number>()
const reading = new Map<string, Promise<RepoKnowledge>>()

const withoutTimes = (k: RepoKnowledge) => JSON.stringify(k.facts.map(({ at: _at, ...f }) => f))

async function readRepo(path: string): Promise<RepoReading | null> {
  let timer = 0
  try {
    return await Promise.race([
      invoke<RepoReading | null>('knowledge:read', path).then((r) => r ?? null),
      new Promise<null>((done) => void (timer = window.setTimeout(() => done(null), READ_TIMEOUT_MS)))
    ])
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/** Fold a read into the board's knowledge. A read that changes nothing leaves the board alone, so it costs no save. */
function applyReading(projectId: string, r: RepoReading) {
  const before = currentKnowledge()
  const next = mergeFacts(before, r.facts, ['repo'])
  if (withoutTimes(next) !== withoutTimes(before)) write(projectId, { ...next, readAt: Date.now() })
  lastRead.set(projectId, Date.now())
}

/**
 * The knowledge for the open board, read from the repo again first if this session has not read it in
 * the last few minutes. Never throws and never waits past READ_TIMEOUT_MS: a repo that cannot be read
 * is a goal with more guesses in its charter, not a goal held up.
 */
export function refreshKnowledge(force = false): Promise<RepoKnowledge> {
  const p = useApp.getState().project
  if (!p) return Promise.resolve(emptyKnowledge())
  if (!force && Date.now() - (lastRead.get(p.id) ?? 0) < READ_EVERY_MS) return Promise.resolve(currentKnowledge())
  const running = reading.get(p.id)
  if (running) return running
  const promise = (async () => {
    const r = await readRepo(p.path)
    if (r) applyReading(p.id, r)
    return useApp.getState().project?.id === p.id ? currentKnowledge() : emptyKnowledge()
  })().finally(() => reading.delete(p.id))
  reading.set(p.id, promise)
  return promise
}

/** Read each board's repo as it opens, so the first goal typed into it already has its checks known. */
export function watchKnowledge() {
  let open: string | undefined
  const check = () => {
    const id = useApp.getState().project?.id
    if (id === open) return
    open = id
    if (id) void refreshKnowledge()
  }
  useApp.subscribe(check)
  check()
}

const learnPrompt = (k: RepoKnowledge, docs: string[]) => {
  const known = knowledgeBlock({ ...k, facts: k.facts.filter((f) => f.provenance !== 'inferred') })
  return `You are writing standing knowledge about the repository in this folder for Fleetboard, where AI coding agents plan and do work. Every fact is shown to the user with where it came from, and is cited when an agent's job is agreed, so a wrong fact does real harm: leave out anything you are not sure of.
Already known (do not repeat these):
${known || '(nothing yet)'}

Read ${docs.length ? docs.join(', ') : 'the readme, if there is one'} first, then as much else as you need: manifests, CI workflows, the main source folders.
Reply with ONLY a JSON object, no prose, no code fences:
{"facts":[{"topic":"checks|ownership|style|done|layout","key":"<short-slug>","text":"<one sentence with the real paths, commands and names>","source":"<repo-relative file it came from>","fromReadme":false,"command":"<the shell command, for a check>"}]}
Topics: checks = how work is checked here and what each check covers. ownership = who or what owns an area, and which areas are generated or vendored and must not be edited by hand. style = conventions the code here follows. done = what finished means here beyond the checks (a changelog line, docs, a screenshot, a review). layout = where things live.
"fromReadme": true only when the fact is stated in ${docs.length ? `one of ${docs.join(', ')}` : 'the readme'}, with that file as "source". Leave out "command" when there is none.
At most 12 facts, each one sentence. Only what stays true for weeks: no current state, no TODOs, no guesses.`
}

export interface Learned {
  ok: boolean
  /** how many facts the pass added or replaced */
  added: number
  error?: string
}

/**
 * Rebuild: read the repo, then one model pass through the user's planner CLI. Only ever from the user
 * asking — it spends their tokens. The facts it finds replace the last pass's and nothing else, so a fact
 * the user corrected or deleted stays that way; a pass that fails changes nothing but the read.
 */
export function learnKnowledge(): { promise: Promise<Learned>; cancel: () => void } {
  const app = useApp.getState()
  const p = app.project
  if (!p) return { promise: Promise.resolve({ ok: false, added: 0, error: 'Open a project first' }), cancel: () => {} }
  let run: ReturnType<typeof runCli> | null = null
  let cancelled = false
  let timer = 0
  const promise = (async (): Promise<Learned> => {
    const r = await readRepo(p.path)
    if (r) applyReading(p.id, r)
    if (cancelled) return { ok: false, added: 0, error: 'Stopped' }
    if (useApp.getState().project?.id !== p.id) return { ok: false, added: 0, error: 'The project changed, so nothing was kept' }
    const docs = r?.docs ?? []
    run = runCli({ prompt: learnPrompt(currentKnowledge(), docs), cwd: p.path, agentId: readOnlyAgent(app.settings.plannerAgent) })
    try {
      const res = await Promise.race([run.promise, new Promise<null>((done) => void (timer = window.setTimeout(() => done(null), LEARN_TIMEOUT_MS)))])
      if (cancelled) return { ok: false, added: 0, error: 'Stopped' }
      if (!res) {
        run.cancel()
        return { ok: false, added: 0, error: `No answer after ${Math.round(LEARN_TIMEOUT_MS / 60_000)} minutes` }
      }
      const json = extractJson(res.text)
      // a prose reply, a missing CLI and a failed login look alike from here, so the last line says which
      if (!json) return { ok: false, added: 0, error: res.code ? res.text.trim().split('\n').pop() || `The planner exited with ${res.code}` : 'The reply had no facts in it' }
      const learned = coerceLearned(json, docs)
      const before = currentKnowledge()
      const next = { ...mergeFacts(before, learned, ['readme', 'inferred']), learnedAt: Date.now() }
      if (!write(p.id, next)) return { ok: false, added: 0, error: 'The project changed, so nothing was kept' }
      const kept = new Set(next.facts.map((f) => `${f.key}\u0000${f.provenance}\u0000${f.text}`))
      return { ok: true, added: learned.filter((f) => kept.has(`${f.key}\u0000${f.provenance}\u0000${f.text}`)).length }
    } catch (e) {
      return { ok: false, added: 0, error: String(e) }
    } finally {
      window.clearTimeout(timer)
    }
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      run?.cancel()
    }
  }
}

/**
 * Keep what the user changed on a charter before confirming it, a field at a time. `repeatedCorrections`
 * reads them: the same change made on several goals is offered in the panel as a fact to keep.
 */
export function recordCharterEdits(drafted: Charter, confirmed: Charter) {
  const deltas = charterDeltas(drafted, confirmed)
  if (deltas.length) changeKnowledge((k) => withDeltas(k, deltas))
}

/** Tests only. */
export function forgetReadsForTest() {
  lastRead.clear()
  reading.clear()
}
