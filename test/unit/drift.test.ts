// Oracle's ambient line: one sentence when live work drifts from its charter, composed here from the
// drift itself, and nothing otherwise. Most of these are about the nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyFleet, type FleetMember, type FleetState, type FleetTask } from '../../src/shared/fleet'
import { coerceCharter } from '../../src/shared/charter'
import { driftOf } from '../../src/shared/drift'

const MIN = 60_000
const NOW = 100 * MIN

const member = (over: Partial<FleetMember> & { id: string; name: string }): FleetMember => ({
  role: 'worker',
  leadId: 'lead',
  agentId: 'claude',
  projectId: 'p',
  cwd: '/tmp/wt',
  status: 'working',
  createdAt: NOW - 10 * MIN,
  lastOutputAt: NOW - 10_000,
  ...over
})

/** A team on track: a working Lead and one worker that printed something seconds ago. */
function team(o: { tasks?: FleetTask[]; members?: FleetMember[]; doneWhen?: string; estimate?: number } = {}): FleetState {
  const s = emptyFleet('p', '/repo')
  const all = [member({ id: 'lead', name: 'Lead', role: 'lead', leadId: undefined }), member({ id: 'ada', name: 'Ada' }), ...(o.members ?? [])]
  s.members = Object.fromEntries(all.map((m) => [m.id, m]))
  s.tasks = o.tasks ?? [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: NOW - 4 * MIN, estimate: 10 }]
  s.charter = coerceCharter({ understood: 'u', doneWhen: o.doneWhen ?? 'npm test', ...(o.estimate ? { estimate: o.estimate } : {}) }, 'r')
  return s
}

// Review Focus 5
test('work on track says nothing', () => {
  assert.equal(driftOf(team(), NOW), null)
  assert.equal(driftOf(null, NOW), null)
  assert.equal(driftOf(emptyFleet('p', '/repo'), NOW), null, 'no team at all')
  const s = team()
  s.check = { command: 'npm test', runs: [{ at: 1, code: 1, failing: 9 }, { at: 2, code: 1, failing: 4 }, { at: 3, code: 0, failing: 0 }] }
  assert.equal(driftOf(s, NOW), null, 'a check getting better is on track')
  const slow = team({ tasks: [{ id: 't', title: 'x', owner: 'ada', status: 'doing', startedAt: NOW - 12 * MIN, estimate: 10 }] })
  assert.equal(driftOf(slow, NOW), null, 'a little over the estimate colours the figure; it is not worth a line')
})

test('a member gone quiet is said, with how long and on what — even with nothing estimated', () => {
  const s = team({ tasks: [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: NOW - 30 * MIN }] })
  s.members.ada!.lastOutputAt = NOW - 7 * MIN
  s.charter = coerceCharter({ understood: 'u' }, 'r')
  const d = driftOf(s, NOW)
  assert.equal(d?.kind, 'silent')
  assert.equal(d?.text, 'Ada has been silent for 7 min on “Write the parser”.')
  assert.equal(d?.consoleId, 'ada')
})

test('a task far past its estimate is said; the job too, against the charter’s', () => {
  const s = team({ tasks: [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: NOW - 25 * MIN, estimate: 10 }] })
  assert.equal(driftOf(s, NOW)?.text, 'Ada is at 25 min on “Write the parser”, est 10 min.')
  const job = team({ estimate: 20 })
  job.members.lead!.createdAt = NOW - 45 * MIN
  assert.equal(driftOf(job, NOW)?.text, 'The team is at 45 min on this job, est 20 min.')
  job.ready = { leadId: 'lead', branch: 'b', summary: 's', commits: 1, files: [], at: NOW }
  assert.equal(driftOf(job, NOW), null, 'a job handed in is not drifting')
})

test('the check going the wrong way is said, from its own two runs', () => {
  const worse = team()
  worse.check = { command: 'npm test', runs: [{ at: 1, code: 1, failing: 3 }, { at: 2, code: 1, failing: 7 }] }
  assert.equal(driftOf(worse, NOW)?.text, '`npm test` went from 3 failing to 7 since its last run.')
  const broke = team()
  broke.check = { command: 'npm test', runs: [{ at: 1, code: 0 }, { at: 2, code: 1, failing: 2 }] }
  assert.equal(driftOf(broke, NOW)?.text, '`npm test` passed on its last run and fails now (2 failing).')
  const timedOut = team()
  timedOut.check = { command: 'npm test', runs: [{ at: 1, code: 0 }, { at: 2, code: null, timedOut: true }] }
  assert.equal(driftOf(timedOut, NOW), null, 'a run that did not answer says nothing about the direction')
  const off = team()
  off.check = { command: 'npm test', off: true, runs: worse.check.runs }
  assert.equal(driftOf(off, NOW), null, 'switched off is switched off')
})

test('two drifts at once give the heavier one, and only one', () => {
  const s = team({ tasks: [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: NOW - 25 * MIN, estimate: 10 }] })
  s.members.ada!.lastOutputAt = NOW - 8 * MIN
  assert.equal(driftOf(s, NOW)?.kind, 'silent', 'silence outweighs the estimate')
  s.check = { command: 'npm test', runs: [{ at: 1, code: 0 }, { at: 2, code: 1 }] }
  assert.equal(driftOf(s, NOW)?.kind, 'check', 'the charter’s own check outweighs both')
})

test('a dismissed drift stays dismissed until it happens again', () => {
  const s = team()
  s.members.ada!.lastOutputAt = NOW - 8 * MIN
  const first = driftOf(s, NOW)!
  const dismissed = new Set([first.key])
  // the Lead keeps talking throughout, so Ada is the only one quiet
  s.members.lead!.lastOutputAt = NOW + 8 * MIN
  assert.equal(driftOf(s, NOW + 5 * MIN, { dismissed }), null)
  // it spoke, then went quiet again: a new silence
  s.members.ada!.lastOutputAt = NOW + 2 * MIN
  assert.ok(driftOf(s, NOW + 9 * MIN, { dismissed }), 'a new silence is a new line')
})

test('with its heaviest drift dismissed, the next one is shown', () => {
  const s = team({ tasks: [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: NOW - 25 * MIN, estimate: 10 }] })
  s.members.ada!.lastOutputAt = NOW - 8 * MIN
  const silent = driftOf(s, NOW)!
  assert.equal(driftOf(s, NOW, { dismissed: new Set([silent.key]) })?.kind, 'over')
})

test('no working Lead, no line — whatever the state still carries', () => {
  const s = team()
  s.members.ada!.lastOutputAt = NOW - 30 * MIN
  s.members.lead!.status = 'reported'
  assert.equal(driftOf(s, NOW), null, 'the Lead handed in')
  s.members.lead!.status = 'working'
  assert.equal(driftOf(s, NOW, { live: () => false }), null, 'its console is gone')
  assert.ok(driftOf(s, NOW, { live: () => true }))
})
