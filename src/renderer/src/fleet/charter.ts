// Making a charter: the prompt fragment both producers send, the standalone draft for a door that
// never consults Oracle, and the check that what a charter cites is really in the repo, or in what is
// known about it (fleet/knowledge.ts).
// Through Oracle the charter rides the pass that is already happening (voice/helm/helm.ts), so this
// file's own model call is the exception, not the common path.
// And the gate: every door that gives work to a team puts its charter up here and waits for the user.
import { create } from 'zustand'
import { type Charter, type CharterAssumption, coerceCharter, scoreConfidence } from '@shared/charter'
import type { FleetMember } from '@shared/fleet'
import { type RepoKnowledge, citable, emptyKnowledge, knowledgeBlock } from '@shared/knowledge'
import { norm } from '@shared/mergeReview'
import { useApp } from '../state/store'
import { setVoice, useVoice } from '../voice/thread'
import { extractJson, invoke, runCli } from '../lib/api'
import { currentKnowledge, recordCharterEdits, refreshKnowledge } from './knowledge'
import { readOnlyAgent } from '@shared/agents'

/**
 * The charter's JSON and the rules a model writes it by. One text, sent by Oracle inside its `team`
 * option and by `draftCharter` on its own, so the two producers cannot drift apart.
 *
 * The wontTouch rule is the load-bearing one: the merge gate matches a path, a folder or a glob, so
 * an exclusion written as prose matches nothing and protects nothing (the card marks it so).
 */
export const CHARTER_FIELDS = `{"understood":"<one or two sentences: the result the user wants, in your own words>","assumptions":[{"text":"<something you are taking as given>","known":true,"from":"<repo-relative path, or fact:<key>>"},{"text":"<something you are guessing>","known":false}],"wontTouch":["<repo-relative file, folder or glob>"],"doneWhen":"<the check that proves it is finished>","estimate":<minutes>,"ambiguity":"scope|acceptance|subject|constraint","question":{"text":"<the one thing to ask>","options":["<a likely answer>"]}}
Charter rules:
- assumptions: whatever you are taking as given that the request did not say. "known":true only when you looked and the repo shows it, and "from" is then the repo-relative path that shows it and nothing else on that line; for a command, the file that defines it ("package.json" for an npm script). Where one of the facts known about this repo says it, "from" is "fact:" and that fact's key instead ("fact:checks.test"); a fact marked inferred is not evidence, so an assumption resting on one is "known":false. Everything else is "known":false with no "from". A guess marked as a guess is fine; a guess dressed up as known is not.
- wontTouch: what this work must leave alone, each entry a repo-relative file ("package.json"), folder ("src/renderer") or glob ("*.lock", "src/**/*.tsx"), with no leading slash. These are matched against the files a worker changes and a merge is refused when one is touched, so never write a description ("the renderer"): it matches nothing and protects nothing. [] when the user ruled nothing out; do not invent exclusions.
- doneWhen: the shell command that proves it where one exists ("npm test"), otherwise one short sentence; "" when nothing can be checked.
- estimate: how many minutes the whole job should take a team, as a plain number. It is shown against the time actually taken, so a guess is fine; leave it out rather than inventing precision.
- ambiguity and question: only when something material is unclear. ambiguity names the kind of gap: scope (how much), acceptance (how to tell it is finished), subject (which thing the request means) or constraint (a limit it did not state). Ask at most one question, the one with the most leverage, and guess the rest, marked as guesses. Leave both out when nothing is unclear.
- Never report a confidence number: it is computed from the evidence above, not from what you claim.`

/** What is known about the repo, as the draft is shown it: empty when nothing is, so a fresh repo's prompt is what it always was. */
const knownSection = (k: RepoKnowledge) => {
  const block = knowledgeBlock(k)
  return block ? `\nKnown about this repo (cite one as fact:<key>):\n${block}\n` : ''
}

const draftPrompt = (request: string, procedure: string | undefined, k: RepoKnowledge) => `You are drafting a charter for Fleetboard, where a Lead agent will plan work and run workers in git worktrees on this repo. Before anyone starts, the user will check what you understood their request to be.
Reply with ONLY a JSON object, no prose, no code fences:
${CHARTER_FIELDS}
${knownSection(k)}
User request: ${JSON.stringify(request)}${procedure ? `
The work will follow this procedure, already chosen by the user; the charter must not describe a job it contradicts: ${JSON.stringify(procedure)}` : ''}`

/**
 * The longest a draft may hold up the goal. This call is all that stands between a click and
 * anything happening, and a CLI that never answers has no exit of its own, so past this the goal
 * goes on without a drafted charter.
 */
export const DRAFT_TIMEOUT_MS = 40_000

/**
 * A charter from its own model call, for a door that never consults Oracle (a playbook, a
 * brainstorm idea). A bad, missing or slow reply costs confidence, never the goal. `procedure` is how the work
 * will be done where the user has already chosen that (a playbook's step list): it informs the draft but
 * is not the request, which stays the user's words and is what a failed draft falls back to.
 */
export async function draftCharter(request: string, procedure?: string): Promise<Charter> {
  const app = useApp.getState()
  if (!app.project) return coerceCharter(null, request)
  // what is already stored, not a fresh read: the draft is the wait the user sees, and the board's
  // repo was read when it opened (watchKnowledge). The gate reads again before it checks the citations.
  const run = runCli({ prompt: draftPrompt(request, procedure, currentKnowledge()), cwd: app.project.path, agentId: readOnlyAgent(app.settings.plannerAgent) })
  // the same thinking orb and stop button a planner call gets: this one used to run with nothing on screen
  setVoice({ phase: 'thinking', cancelThinking: () => run.cancel() })
  let timer = 0
  try {
    const res = await Promise.race([run.promise, new Promise<null>((done) => void (timer = window.setTimeout(() => done(null), DRAFT_TIMEOUT_MS)))])
    if (!res) {
      run.cancel()
      console.warn(`[charter] no draft after ${Math.round(DRAFT_TIMEOUT_MS / 1000)}s; carrying on from the request alone`)
      return coerceCharter(null, request)
    }
    const json = extractJson(res.text)
    // a prose reply, a missing CLI and a failed login all come out as the same card, so each says which it was
    if (!json) console.warn(`[charter] no JSON in the draft (exit ${res.code}); carrying on from the request alone:`, res.text.trim().slice(0, 200))
    return coerceCharter(json, request)
  } catch (e) {
    console.warn('[charter] the draft could not run; carrying on from the request alone:', e)
    return coerceCharter(null, request)
  } finally {
    window.clearTimeout(timer)
    // not a blanket reset: a listen that started meanwhile owns the phase now
    setVoice(useVoice.getState().phase === 'thinking' ? { phase: 'idle', cancelThinking: null } : { cancelThinking: null })
  }
}

const FACT_CITE = /^fact:\s*(\S+)$/i

/**
 * Any assumption claiming to rest on something that is not there is a guess, and the charter is
 * scored again. `exists` is the caller's, so this stays pure: the renderer asks `fs:exists`, which is
 * confined to the project, so a path outside it counts as missing — nothing outside the repo is
 * evidence about it.
 *
 * A `fact:<key>` citation is looked up in the repo knowledge instead, and is known only when that fact
 * is one a charter may rest on (`citable`: not a model's inference the user has not confirmed). This is
 * the only place `fact` is set; whatever a model wrote there is dropped and the line checked as a path,
 * since believing it would let a reply skip the check altogether.
 */
export function verifyEvidence(c: Charter, exists: (p: string) => boolean, known: RepoKnowledge = emptyKnowledge()): Charter {
  // a downgrade drops `from` too, so it looks like any other guess and does not keep citing a path that is not there
  const assumptions = c.assumptions.map((a): CharterAssumption => {
    if (!a.known || !a.from) return { text: a.text, known: false }
    const key = FACT_CITE.exec(a.from)?.[1]
    if (key) {
      const f = citable(known, key)
      return f ? { text: a.text, known: true, from: f.source ?? 'repo knowledge', fact: f.key } : { text: a.text, known: false }
    }
    return exists(a.from) ? { text: a.text, known: true, from: a.from } : { text: a.text, known: false }
  })
  return { ...c, assumptions, confidence: scoreConfidence({ assumptions, wontTouch: c.wontTouch, doneWhen: c.doneWhen, question: c.question }) }
}

/**
 * When the charter's done-when runs a check the repo was read to have, it says so as a known line. That
 * the check is the repo's own is exactly the kind of thing the knowledge exists to make known, and it
 * makes a charter's confidence move with the knowledge even when the model cited none of it. Written as
 * a citation, so it goes through `verifyEvidence` like any other.
 */
export function citeKnownCheck(c: Charter, k: RepoKnowledge): Charter {
  const parts = c.doneWhen.split(/\s*(?:&&|;)\s*/).map((x) => x.trim())
  // cited either way: as the model writes it, or as the gate has already resolved it
  const cited = new Set(c.assumptions.flatMap((a) => (a.known ? [a.fact ?? FACT_CITE.exec(a.from ?? '')?.[1] ?? ''] : [])))
  const added: CharterAssumption[] = k.facts
    .filter((f) => f.topic === 'checks' && f.command && parts.includes(f.command) && !cited.has(f.key) && citable(k, f.key))
    .map((f) => ({ text: `\`${f.command}\` is one of this repo’s own checks`, known: true, from: `fact:${f.key}` }))
  return added.length ? { ...c, assumptions: [...c.assumptions, ...added].slice(0, 12) } : c
}

// ---------------------------------------------------------------- the gate

/** What a person changes on the card, a field at a time. The rest of a charter is not theirs to edit. */
export type CharterEdit = Partial<Pick<Charter, 'understood' | 'assumptions' | 'wontTouch' | 'doneWhen' | 'ambiguity' | 'question'>>

interface CharterGate {
  /** the charter waiting for a glance, if any; one that arrives meanwhile waits behind it */
  pending: Charter | null
  edit: (patch: CharterEdit) => void
  confirm: () => void
  dismiss: () => void
}

/** `shown` is the charter as the gate first put it up, so what the user changed before confirming can be kept. */
const waiting: { charter: Charter; shown: Charter; settle: (c: Charter | null) => void }[] = []

/**
 * A charter through coercion again. A stored one is only ever as good as the last time it was
 * checked: an edit that blanks an exclusion would otherwise keep the score the exclusion earned.
 */
const recoerced = (c: Charter, patch: CharterEdit = {}): Charter => ({
  ...coerceCharter({ ...c, ...patch }, c.request, c.at),
  ...(c.followUpTo ? { followUpTo: c.followUpTo } : {}),
  ...(c.replaces ? { replaces: c.replaces } : {})
})

const showFront = () => useCharter.setState({ pending: waiting[0]?.charter ?? null })

function settleFront(confirmed: boolean) {
  const front = waiting.shift()
  if (!front) return
  showFront()
  // only a confirmed charter's edits: a dismissed one was not agreed to, so what was changed on it corrects nothing
  if (confirmed) recordCharterEdits(front.shown, front.charter)
  front.settle(confirmed ? front.charter : null)
}

export const useCharter = create<CharterGate>(() => ({
  pending: null,
  edit: (patch) => {
    const front = waiting[0]
    if (!front) return
    front.charter = recoerced(front.charter, patch)
    showFront()
  },
  confirm: () => settleFront(true),
  dismiss: () => settleFront(false)
}))

/**
 * Put a charter up for confirmation. Resolves to the confirmed charter, or null if it was dismissed.
 * It is always coercion output, so whatever reaches `startLead` cannot throw where the Lead's goal
 * is composed, after its worktree and console already exist.
 */
export function openGate(c: Charter): Promise<Charter | null> {
  return new Promise((resolve) => {
    const shown = recoerced(c)
    waiting.push({ charter: shown, shown, settle: resolve })
    showFront()
  })
}

/**
 * Let go of every door still waiting, resolving each as dismissed. For a project closed or switched:
 * the card names a Lead and a repo that are no longer on screen, and nobody left can answer it, so a
 * promise kept waiting there is one that never settles.
 */
export function clearGate() {
  const abandoned = waiting.splice(0)
  showFront()
  for (const w of abandoned) w.settle(null)
}

/** Which route a request takes. With a team member to receive it, the charter is a follow-up to them and says so. */
export const gateTarget = (to: FleetMember | undefined): { followUpTo?: string } => (to ? { followUpTo: to.id } : {})

const rooted = (p: string) => /^([a-zA-Z]:)?\//.test(p)

/**
 * `fs:exists` is async and `verifyEvidence` is not, so what a charter cites is asked about up front.
 * Paths are `norm`alised first, as the merge gate does, so `./package.json` and `src\main\cli.ts` are
 * the files they mean; an absolute path is asked as it is, and the main process answers false outside the project.
 */
async function citedThatExist(c: Charter, root: string | undefined): Promise<Set<string>> {
  // a fact is looked up in the knowledge, not on disk
  const cited = [...new Set(c.assumptions.flatMap((a) => (a.known && a.from && !FACT_CITE.test(a.from) ? [norm(a.from)] : [])))]
  if (!root) return new Set()
  const found = await Promise.all(cited.map((p) => invoke<boolean>('fs:exists', rooted(p) ? p : `${root}/${p}`).catch(() => false)))
  return new Set(cited.filter((_, i) => found[i]))
}

/**
 * The gate every door into the team crosses: what the charter cites is checked against the repo, it
 * is marked a follow-up when it is going to a team member, and nothing happens until the user has seen it.
 *
 * A follow-up carries no exclusions. The team's own charter is the one the merge gates read, and a
 * follow-up's are deliberately not merged into it, so a "Won't touch" row on that card would promise
 * a rule nothing enforces. Whether a follow-up should amend the team's exclusions or replace them is
 * the open question; until it is answered, the card does not claim either.
 */
export async function gateCharter(c: Charter, to?: FleetMember): Promise<Charter | null> {
  // bounded and never throws: a repo that cannot be read is a charter with more guesses, not a goal held up
  const known = await refreshKnowledge()
  const withCheck = citeKnownCheck(c, known)
  const there = await citedThatExist(withCheck, useApp.getState().project?.path)
  const checked = verifyEvidence(withCheck, (p) => there.has(norm(p)), known)
  return openGate({ ...checked, followUpTo: undefined, ...gateTarget(to), ...(to ? { wontTouch: [] } : {}) })
}
