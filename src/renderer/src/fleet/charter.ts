// Making a charter: the prompt fragment both producers send, the standalone draft for a door that
// never consults Oracle, and the check that what a charter cites is really in the repo.
// Through Oracle the charter rides the pass that is already happening (voice/helm/helm.ts), so this
// file's own model call is the exception, not the common path.
// And the gate: every door that gives work to a team puts its charter up here and waits for the user.
import { create } from 'zustand'
import { type Charter, coerceCharter, scoreConfidence } from '@shared/charter'
import type { FleetMember } from '@shared/fleet'
import { norm } from '@shared/mergeReview'
import { useApp } from '../state/store'
import { setVoice, useVoice } from '../voice/thread'
import { extractJson, invoke, runCli } from '../lib/api'

/**
 * The charter's JSON and the rules a model writes it by. One text, sent by Oracle inside its `team`
 * option and by `draftCharter` on its own, so the two producers cannot drift apart.
 *
 * The wontTouch rule is the load-bearing one: the merge gate matches a path, a folder or a trailing
 * `*` and nothing else, so an exclusion written as prose or a glob matches nothing and protects
 * nothing while the card says it does.
 */
export const CHARTER_FIELDS = `{"understood":"<one or two sentences: the result the user wants, in your own words>","assumptions":[{"text":"<something you are taking as given>","known":true,"from":"<repo-relative path>"},{"text":"<something you are guessing>","known":false}],"wontTouch":["<repo-relative file, folder or folder/*>"],"doneWhen":"<the check that proves it is finished>","estimate":<minutes>,"ambiguity":"scope|acceptance|subject|constraint","question":{"text":"<the one thing to ask>","options":["<a likely answer>"]}}
Charter rules:
- assumptions: whatever you are taking as given that the request did not say. "known":true only when you looked and the repo shows it, and "from" is then the repo-relative path that shows it and nothing else on that line; for a command, the file that defines it ("package.json" for an npm script). Everything else is "known":false with no "from". A guess marked as a guess is fine; a guess dressed up as known is not.
- wontTouch: what this work must leave alone, each entry a repo-relative file ("package.json"), folder ("src/renderer") or folder prefix ("src/renderer/*": a single trailing * and no other wildcard), with no leading slash. These are matched against the files a worker changes and a merge is refused when one is touched, so never write a description ("the renderer") or a glob ("src/renderer/**", "src/**/*.tsx"): they match nothing and protect nothing. [] when the user ruled nothing out; do not invent exclusions.
- doneWhen: the shell command that proves it where one exists ("npm test"), otherwise one short sentence; "" when nothing can be checked.
- estimate: how many minutes the whole job should take a team, as a plain number. It is shown against the time actually taken, so a guess is fine; leave it out rather than inventing precision.
- ambiguity and question: only when something material is unclear. ambiguity names the kind of gap: scope (how much), acceptance (how to tell it is finished), subject (which thing the request means) or constraint (a limit it did not state). Ask at most one question, the one with the most leverage, and guess the rest, marked as guesses. Leave both out when nothing is unclear.
- Never report a confidence number: it is computed from the evidence above, not from what you claim.`

const draftPrompt = (request: string, procedure?: string) => `You are drafting a charter for Fleetboard, where a Lead agent will plan work and run workers in git worktrees on this repo. Before anyone starts, the user will check what you understood their request to be.
Reply with ONLY a JSON object, no prose, no code fences:
${CHARTER_FIELDS}

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
  const run = runCli({ prompt: draftPrompt(request, procedure), cwd: app.project.path, agentId: app.settings.plannerAgent || undefined })
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

/**
 * Any assumption claiming to rest on something that is not there is a guess, and the charter is
 * scored again. `exists` is the caller's, so this stays pure: the renderer asks `fs:exists`, which is
 * confined to the project, so a path outside it counts as missing — nothing outside the repo is
 * evidence about it.
 */
export function verifyEvidence(c: Charter, exists: (p: string) => boolean): Charter {
  // a downgrade drops `from` too, so it looks like any other guess and does not keep citing a path that is not there
  const assumptions = c.assumptions.map((a) => (a.known && !(a.from && exists(a.from)) ? { text: a.text, known: false } : a))
  return { ...c, assumptions, confidence: scoreConfidence({ assumptions, wontTouch: c.wontTouch, doneWhen: c.doneWhen, question: c.question }) }
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

const waiting: { charter: Charter; settle: (c: Charter | null) => void }[] = []

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
    waiting.push({ charter: recoerced(c), settle: resolve })
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
  const cited = [...new Set(c.assumptions.flatMap((a) => (a.known && a.from ? [norm(a.from)] : [])))]
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
  const there = await citedThatExist(c, useApp.getState().project?.path)
  const checked = verifyEvidence(c, (p) => there.has(norm(p)))
  return openGate({ ...checked, followUpTo: undefined, ...gateTarget(to), ...(to ? { wontTouch: [] } : {}) })
}
