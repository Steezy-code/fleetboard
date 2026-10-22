// Making a charter: the prompt fragment both producers send, the standalone draft for a door that
// never consults Oracle, and the check that what a charter cites is really in the repo.
// Through Oracle the charter rides the pass that is already happening (voice/helm/helm.ts), so this
// file's own model call is the exception, not the common path.
import { type Charter, coerceCharter, scoreConfidence } from '@shared/charter'
import { useApp } from '../state/store'
import { extractJson, runCli } from '../lib/api'

/**
 * The charter's JSON and the rules a model writes it by. One text, sent by Oracle inside its `team`
 * option and by `draftCharter` on its own, so the two producers cannot drift apart.
 *
 * The wontTouch rule is the load-bearing one: the merge gate matches a path, a folder or a trailing
 * `*` and nothing else, so an exclusion written as prose or a glob matches nothing and protects
 * nothing while the card says it does.
 */
export const CHARTER_FIELDS = `{"understood":"<one or two sentences: the result the user wants, in your own words>","assumptions":[{"text":"<something you are taking as given>","known":true,"from":"<repo-relative path>"},{"text":"<something you are guessing>","known":false}],"wontTouch":["<repo-relative file, folder or folder/*>"],"doneWhen":"<the check that proves it is finished>","ambiguity":"scope|acceptance|subject|constraint","question":{"text":"<the one thing to ask>","options":["<a likely answer>"]}}
Charter rules:
- assumptions: whatever you are taking as given that the request did not say. "known":true only when you looked and the repo shows it, and "from" is then the repo-relative path that shows it and nothing else on that line; for a command, the file that defines it ("package.json" for an npm script). Everything else is "known":false with no "from". A guess marked as a guess is fine; a guess dressed up as known is not.
- wontTouch: what this work must leave alone, each entry a repo-relative file ("package.json"), folder ("src/renderer") or folder prefix ("src/renderer/*"), with no leading slash. These are matched against the files a worker changes and a merge is refused when one is touched, so never write a description ("the renderer") or a glob ("src/**/*.tsx"): they match nothing and protect nothing. [] when the user ruled nothing out; do not invent exclusions.
- doneWhen: the shell command that proves it where one exists ("npm test"), otherwise one short sentence; "" when nothing can be checked.
- ambiguity and question: only when something material is unclear. ambiguity names the kind of gap: scope (how much), acceptance (how to tell it is finished), subject (which thing the request means) or constraint (a limit it did not state). Ask at most one question, the one with the most leverage, and guess the rest, marked as guesses. Leave both out when nothing is unclear.
- Never report a confidence number: it is computed from the evidence above, not from what you claim.`

const draftPrompt = (request: string) => `You are drafting a charter for Fleetboard, where a Lead agent will plan work and run workers in git worktrees on this repo. Before anyone starts, the user will check what you understood their request to be.
Reply with ONLY a JSON object, no prose, no code fences:
${CHARTER_FIELDS}

User request: ${JSON.stringify(request)}`

/**
 * A charter from its own model call, for a door that never consults Oracle (a playbook, a
 * brainstorm idea). A bad or missing reply costs confidence, never the goal.
 */
export async function draftCharter(request: string): Promise<Charter> {
  const app = useApp.getState()
  if (!app.project) return coerceCharter(null, request)
  try {
    const res = await runCli({ prompt: draftPrompt(request), cwd: app.project.path, agentId: app.settings.plannerAgent || undefined }).promise
    return coerceCharter(extractJson(res.text), request)
  } catch {
    return coerceCharter(null, request)
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
