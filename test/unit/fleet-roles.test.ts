// A team console reaches the fleet tools over MCP with its own bearer token. `tools/list` decides
// only what a member is *told* about, so the role has to be enforced where a tool is actually run:
// without that, a worker — anything able to prompt-inject a worker through a file, issue, dependency
// or PR comment it reads — could call fleet_finish and put its own unreviewed branch on the user's
// Ready card, fleet_dismiss a sibling's unmerged work, or fleet_ask_user to phish an approval.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FleetMember } from '../../src/shared/fleet'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-roles-'))
const { toolDenial, toolRoles, goalMessageFor, leadRestartNote, leadPrompt, briefFor, excludedMergeRefusal, excludedRefusal } = await import('../../src/main/fleet')
const { charterBrief, coerceCharter } = await import('../../src/shared/charter')

/** Every tool a role is allowed to call, straight from the catalogue the server advertises. */
const LEAD_ONLY = [
  'fleet_plan',
  'fleet_update_task',
  'fleet_spawn_worker',
  'fleet_spawn_reviewer',
  'fleet_wait',
  'fleet_merge',
  'fleet_dismiss',
  'fleet_ask_user',
  'fleet_finish'
]
const SHARED = ['fleet_send', 'fleet_status']
const CREW_ONLY = ['fleet_report']

test('a worker may not call the lead-only tools', () => {
  for (const name of LEAD_ONLY) {
    const denied = toolDenial(name, 'worker')
    assert.ok(denied, `${name} must be refused for a worker`)
    assert.match(denied, /you are a worker/)
    // the refusal tells the model what it *can* use, so it keeps working instead of flailing
    assert.match(denied, /fleet_report/)
  }
})

test('a reviewer may not call the lead-only tools either', () => {
  // a reviewer is launched with its edit tools removed; the fleet surface must not hand them back
  for (const name of LEAD_ONLY) assert.ok(toolDenial(name, 'reviewer'), `${name} must be refused for a reviewer`)
})

test('a lead keeps every lead tool, and the shared ones', () => {
  for (const name of [...LEAD_ONLY, ...SHARED]) assert.equal(toolDenial(name, 'lead'), null, name)
})

test('crew report, leads do not; the shared tools are open to all three', () => {
  for (const name of CREW_ONLY) {
    assert.equal(toolDenial(name, 'worker'), null, name)
    assert.equal(toolDenial(name, 'reviewer'), null, name)
    assert.ok(toolDenial(name, 'lead'), `${name} is not a lead tool`)
  }
  for (const name of SHARED) for (const role of ['lead', 'worker', 'reviewer'] as const) assert.equal(toolDenial(name, role), null, `${name}/${role}`)
})

test('an unknown tool name is refused for every role', () => {
  for (const role of ['lead', 'worker', 'reviewer'] as const) {
    assert.match(String(toolDenial('fleet_merge_everything', role)), /Unknown tool/)
    assert.match(String(toolDenial('', role)), /Unknown tool/)
    // not reachable through the switch, but a name must never be allowed by accident
    assert.match(String(toolDenial('__proto__', role)), /Unknown tool/)
  }
  assert.equal(toolRoles('fleet_merge_everything'), null)
})

test('every tool in the catalogue names at least one role', () => {
  for (const name of [...LEAD_ONLY, ...SHARED, ...CREW_ONLY]) {
    const roles = toolRoles(name)
    assert.ok(roles && roles.length, `${name} is in the catalogue`)
  }
})

test('callTool enforces the role before it runs anything', () => {
  // toolDenial is only worth having if callTool actually consults it: a refactor that drops the
  // guard would leave every test above passing while the hole is wide open again.
  const src = fs.readFileSync(new URL('../../src/main/fleet.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async function callTool('))
  const guard = body.indexOf('toolDenial(name, m.role)')
  const firstCase = body.indexOf("case 'fleet_")
  assert.ok(guard > 0, 'callTool must consult toolDenial')
  assert.ok(firstCase > 0 && guard < firstCase, 'the role check must come before the first tool runs')
})

// ---- the Lead works from the charter the user confirmed, not from the request they typed

const CHARTER = coerceCharter(
  {
    understood: 'Add a split subcommand',
    assumptions: [{ text: 'the CLI lives in src/cli', known: true, from: 'src/cli/index.ts' }],
    wontTouch: ['the billing module'],
    doneWhen: 'npm test passes'
  },
  'add split to the cli',
  1
)

const LEAD_MEMBER: FleetMember = { id: 'con-1', role: 'lead', name: 'Lead', agentId: 'claude', projectId: 'p', cwd: '/repo', branch: 'fleet/x', status: 'working', createdAt: 1 }
const WORKER: FleetMember = { id: 'con-2', role: 'worker', name: 'Ada', agentId: 'claude', projectId: 'p', leadId: 'con-1', task: 'Write the parser', owns: ['src/cli'], doneWhen: 'npm test', cwd: '/repo/.wt', status: 'working', createdAt: 2 }

test('the Lead is briefed from the charter when there is one', () => {
  const text = goalMessageFor(CHARTER, 'add split to the cli')
  assert.match(text, /Add a split subcommand/)
  assert.match(text, /Done when: npm test passes/)
  assert.match(text, /Do not touch: the billing module/)
  assert.doesNotMatch(text, /add split to the cli/, 'the raw request is what the charter replaces')
})

test('without a charter the Lead still gets the raw goal', () => {
  // existing boards, the recovery path and callers that skip the gate have no charter
  assert.equal(goalMessageFor(undefined, 'get to green'), 'get to green')
})

test('without a charter the goal is posted byte for byte, whatever shape it has', () => {
  const raw = '  Playbook "Hotfix". Bug: x.\n1) reproduce it\n2) fix it   '
  assert.equal(goalMessageFor(undefined, raw), raw)
})

// The charter says what the job is and how it is known to be done. A goal that is more than the request
// the user typed (a playbook's step list, Oracle's rewrite) says how to go about it, which the charter does not.
test('a typed goal is the request itself, so the Lead gets the charter alone', () => {
  assert.equal(goalMessageFor(CHARTER, 'add split to the cli'), charterBrief(CHARTER))
  assert.equal(goalMessageFor(CHARTER, '  add split to the cli \n'), charterBrief(CHARTER), 'padding is not a different goal')
})

test("a playbook's step list follows the charter to the Lead", () => {
  const steps = 'Playbook "Hotfix". Bug: ledger sync duplicates a row. 1) Reproduce it with a failing test. 2) Fix it. Never weaken a test to make it pass.'
  const charter = coerceCharter({ understood: 'Fix the duplicate ledger row', doneWhen: 'npm test' }, 'Hotfix: ledger sync duplicates a row', 1)
  const text = goalMessageFor(charter, steps)
  assert.ok(text.startsWith(charterBrief(charter)), 'the agreed job comes first')
  assert.ok(text.endsWith(steps), 'and the procedure after it, whole')
  assert.match(text, /Done when: npm test\. Playbook "Hotfix"/, 'a sentence ends before the procedure starts')
})

test("Oracle's rewrite of the goal follows the charter too", () => {
  const charter = coerceCharter({ understood: 'Make split work on the CLI' }, 'fix the split thing', 1)
  const text = goalMessageFor(charter, 'Find the split subcommand in src/cli and make it write one file per page range.')
  assert.ok(text.startsWith(charterBrief(charter)))
  assert.match(text, /one file per page range\.$/)
})

test('a goal with nothing in it adds nothing after the charter', () => {
  assert.equal(goalMessageFor(CHARTER, '   '), charterBrief(CHARTER))
})

test('the Lead is told the confirmed brief is the user\'s, and where to take doubt', () => {
  const rule = leadPrompt(LEAD_MEMBER)
    .split('\n')
    .find((l) => /not yours to reinterpret/.test(l))
  assert.ok(rule, 'the prompt carries a rule about the confirmed brief')
  // `understood` has no label in the brief, so the rule has to point at the goal itself to cover it
  assert.match(rule, /Your goal as given/)
  assert.match(rule, /Do not touch/)
  assert.match(rule, /Done when/)
  // the one route for a brief that looks wrong, so the Lead asks rather than decides
  assert.match(rule, /fleet_ask_user/)
})

test('the Lead\'s rules stay numbered in order', () => {
  const numbers = leadPrompt(LEAD_MEMBER)
    .split('\n')
    .map((l) => /^(\d+)\. /.exec(l)?.[1])
    .filter(Boolean)
    .map(Number)
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1))
})

test('a worker is told what the user said not to touch', () => {
  const brief = briefFor(WORKER, LEAD_MEMBER, CHARTER.wontTouch)
  assert.match(brief, /Do not touch: the billing module/)
  assert.match(brief, /Write the parser/)
})

test('a worker brief without a charter reads as it did before', () => {
  assert.doesNotMatch(briefFor(WORKER, LEAD_MEMBER), /Do not touch/)
  assert.doesNotMatch(briefFor(WORKER, LEAD_MEMBER, []), /Do not touch/)
})

const HOW = 'Fleetboard was restarted. Your previous conversation was not restored.'
const TAIL = 'Merge any finished work that is not merged yet, call fleet_wait for reports, then carry on.'

test('a restarted Lead whose conversation is gone is given the charter, not the request', () => {
  const note = leadRestartNote({ how: HOW, team: 'nobody started yet', task: 'add split to the cli', charter: CHARTER, resume: false })
  assert.match(note, /Your goal: Add a split subcommand/)
  assert.match(note, /Do not touch: the billing module/)
  assert.doesNotMatch(note, /add split to the cli/)
  // the brief is a paragraph now, so the sentence after it has to start cleanly and the note stay one line
  assert.match(note, /Done when: npm test passes\. Team: nobody started yet\./)
  assert.doesNotMatch(note, /\n/)
})

test('a restarted Lead whose title ran over several lines is still told on one', () => {
  const note = leadRestartNote({ how: HOW, team: 'nobody started yet', task: 'Hotfix: the sync\n\nduplicates a row', charter: CHARTER, resume: false })
  assert.doesNotMatch(note, /[\r\n]/)
  assert.match(note, /Hotfix: the sync duplicates a row Team: nobody started yet\./)
})

test('a restarted Lead on a board with no charter reads exactly as it did', () => {
  const note = leadRestartNote({ how: HOW, team: 'Ada (worker): still working', task: 'get to green', charter: undefined, resume: false })
  assert.equal(note, `[Fleet] ${HOW} Your goal: get to green Team: Ada (worker): still working. ${TAIL}`)
})

test('a Lead whose conversation was restored is not told its goal again', () => {
  for (const charter of [CHARTER, undefined]) {
    const note = leadRestartNote({ how: HOW, team: 'nobody started yet', task: 'get to green', charter, resume: true })
    assert.doesNotMatch(note, /Your goal/)
    assert.equal(note, `[Fleet] ${HOW} Team: nobody started yet. ${TAIL}`)
  }
})

// startLead needs a worktree and a console, memberStarted a live PTY and a worker spawn a running server,
// so none of them can be driven from here. These are the places the charter is wired in; like the
// callTool guard above they pin what the source says, because a revert would leave every test that
// can run green: the charter would still be stored, composed and prompted for, and never reach anyone.
const fleetSrc = () => fs.readFileSync(new URL('../../src/main/fleet.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const bodyOf = (src: string, head: string) => {
  const start = src.indexOf(head)
  assert.ok(start >= 0, `${head} is in fleet.ts`)
  return src.slice(start, src.indexOf('\n}\n', start))
}

test('startLead keeps the charter and briefs the Lead from it', () => {
  const body = bodyOf(fleetSrc(), 'export async function startLead(')
  assert.match(body, /s\.charter = opts\.charter\b/, 'the charter is kept on the state, and cleared when a job starts without one')
  assert.match(body, /kind: 'goal', text: goalMessageFor\(opts\.charter, opts\.goal\)/)
  assert.doesNotMatch(body, /text: opts\.goal/, 'the typed request must not be what the Lead is handed')
})

test("a restarted Lead is handed the board's charter", () => {
  const body = bodyOf(fleetSrc(), 'function memberStarted(')
  assert.match(body, /leadRestartNote\(\{[^}]*\bcharter: s\.charter\b[^}]*\}\)/)
})

test('every worker brief is given the exclusions', () => {
  // the spawn and the restart re-brief: a worker that restarts has lost its conversation, so it needs them again
  const calls = fleetSrc().match(/(?<!function )briefFor\([^)]*\)/g) ?? []
  assert.equal(calls.length, 2, 'fleet_spawn_worker and the restart re-brief')
  for (const c of calls) assert.match(c, /, s\.charter\?\.wontTouch\)$/, c)
})

// ---- a worker that touched what the user ruled out is not merged

test("a merge is refused, naming the file and the exclusion, when the worker touched a won't-touch path", () => {
  const why = excludedRefusal('Ada', ['src/cli/split.ts', 'src/renderer/src/App.tsx'], ['src/renderer/'])
  assert.ok(why)
  assert.match(why, /src\/renderer\/src\/App\.tsx/, 'the file')
  assert.match(why, /"src\/renderer\/"/, 'the exclusion it hit, as the user confirmed it')
  assert.doesNotMatch(why, /split\.ts/, 'a file that broke no exclusion is not blamed')
  assert.match(why, /Ada/)
  assert.match(why, /revert/)
  assert.match(why, /fleet_send/, 'the Lead is told how to get it reverted')
})

test('a merge is allowed when nothing touched is ruled out, and when nothing is', () => {
  assert.equal(excludedRefusal('Ada', ['src/cli/split.ts'], ['src/renderer/']), null)
  assert.equal(excludedRefusal('Ada', ['src/mainframe/x.ts'], ['src/main/']), null)
  assert.equal(excludedRefusal('Ada', ['src/renderer/a.ts'], []), null)
  assert.equal(excludedRefusal('Ada', ['src/renderer/a.ts'], undefined), null, 'a board with no charter merges as it always did')
  assert.equal(excludedRefusal('Ada', [], ['src/renderer/']), null)
})

test('a refusal names every excluded file up to a few, then counts the rest', () => {
  const touched = Array.from({ length: 9 }, (_, i) => `src/renderer/f${i}.ts`)
  const why = excludedRefusal('Ada', touched, ['src/renderer'])!
  assert.match(why, /f0\.ts/)
  assert.match(why, /f4\.ts/)
  assert.doesNotMatch(why, /f5\.ts/, 'the message stays short')
  assert.match(why, /and 4 more/)
})

// ---- and the user's own merge, wherever it was pressed from

test("the user's merge is refused in their own words, naming the file and the rule it hit", () => {
  const why = excludedMergeRefusal(['src/cli/split.ts', 'package.json'], ['package.json'])
  assert.ok(why)
  assert.match(why, /package\.json/, 'the file')
  assert.match(why, /"package\.json"/, 'the exclusion it hit, as the user confirmed it')
  assert.doesNotMatch(why, /split\.ts/, 'a file that broke no exclusion is not blamed')
  assert.doesNotMatch(why, /fleet_send/, 'the user is not told to call a tool only the Lead has')
  assert.match(why, /discard/i, 'and is told what they can do instead')
})

test('the user merges as before when nothing touched is ruled out, and when nothing is', () => {
  assert.equal(excludedMergeRefusal(['src/cli/split.ts'], ['src/renderer/']), null)
  assert.equal(excludedMergeRefusal(['src/renderer/a.ts'], []), null)
  assert.equal(excludedMergeRefusal(['src/renderer/a.ts'], undefined), null, 'a board with no charter merges as it always did')
  assert.equal(excludedMergeRefusal([], ['src/renderer/']), null)
})

test("the user's refusal stays short too, naming a few files and counting the rest", () => {
  const why = excludedMergeRefusal(Array.from({ length: 9 }, (_, i) => `src/renderer/f${i}.ts`), ['src/renderer'])!
  assert.match(why, /f4\.ts/)
  assert.doesNotMatch(why, /f5\.ts/)
  assert.match(why, /and 4 more/)
})

// The Ready card leaves Merge off a blocked review, but a button that is not drawn is not a rule:
// the phone presses Merge through mergeReady as well, and so would any caller added later.
test('mergeReady checks the exclusions itself, before git merges anything', () => {
  const body = bodyOf(fleetSrc(), 'export async function mergeReady(')
  const check = body.indexOf('excludedMergeRefusal(')
  const merge = body.indexOf("'merge', '--no-ff'")
  assert.ok(check > 0 && merge > 0 && check < merge, 'the exclusions are checked before git merge runs')
  assert.match(body, /s\.charter\?\.wontTouch/, "against the board's charter, not a verdict the caller passed in")
  assert.match(body, /HEAD\.\.\.\$\{lead\.branch\}/, 'the diff is what the merge would bring in, not the list the card was drawn from')
  assert.match(body, /'--name-only', '-z', '--no-renames'/, 'read the way the exclusions are matched')
})

test('the phone presses Merge through that same function', () => {
  const remote = fs.readFileSync(new URL('../../src/main/remote.ts', import.meta.url), 'utf8')
  assert.match(remote, /mergeReady\(body\.projectId\)/, '/api/merge calls mergeReady')
  assert.doesNotMatch(remote, /\bgit\(/, 'and does not merge on its own')
})

test('fleet_merge checks the exclusions before it attempts the merge', () => {
  // the check is only worth having if it runs first: a merge that has already landed cannot be unmerged
  // by a refusal, and `git merge --abort` only helps with a conflict
  const src = fleetSrc()
  const start = src.indexOf("case 'fleet_merge':")
  const body = src.slice(start, src.indexOf("case 'fleet_dismiss':", start))
  assert.ok(start > 0 && body.length > 0, 'fleet_merge is in callTool')
  const check = body.indexOf('excludedRefusal(')
  const merge = body.indexOf("'merge', '--no-ff'")
  assert.ok(check > 0 && merge > 0 && check < merge, 'the exclusions are checked before git merge runs')
  assert.match(body, /s\.charter\?\.wontTouch/, "against the board's charter")
  assert.match(body, /HEAD\.\.\.\$\{w\.branch\}/, "the diff is what the merge would bring in: the worker's branch since it left the lead's")
})
