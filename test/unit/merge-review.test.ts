// The pre-merge review is the last thing between an agent's branch and the user's checkout, so the
// two ways it can lie both matter: calling a diff in-scope when it reached outside the files the
// worker was granted, and calling a claim proven when no worker ever reported it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyFleet, type FleetMember, type FleetReady, type FleetState } from '../../src/shared/fleet'
import { ownedBy, reviewReady, stalled } from '../../src/shared/mergeReview'

const member = (over: Partial<FleetMember> & { id: string; name: string }): FleetMember => ({
  role: 'worker',
  leadId: 'lead',
  agentId: 'claude',
  projectId: 'p',
  cwd: '/tmp/wt',
  status: 'merged',
  createdAt: 1000,
  ...over
})

const LEAD: FleetMember = { id: 'lead', name: 'Ada', role: 'lead', agentId: 'claude', projectId: 'p', cwd: '/repo/.wt/lead', status: 'reported', createdAt: 1000 }

function fleet(members: FleetMember[], ready: Partial<FleetReady> & { files: string[] }): FleetState {
  const s = emptyFleet('p', '/repo')
  s.members = Object.fromEntries([LEAD, ...members].map((m) => [m.id, m]))
  s.ready = { leadId: 'lead', branch: 'fleet/x', summary: 'did it', commits: 3, at: 2000, ...ready }
  return s
}

test('ownedBy: the file itself, a folder holding it, or a trailing star', () => {
  assert.equal(ownedBy('src/main/git.ts', ['src/main/git.ts']), true)
  assert.equal(ownedBy('src/main/git.ts', ['src/main']), true)
  assert.equal(ownedBy('src/main/deep/a.ts', ['src/main']), true)
  assert.equal(ownedBy('src/main/git.ts', ['src/main/*']), true)
  assert.equal(ownedBy('anything', []), false)
  assert.equal(ownedBy('anything', undefined), false)
})

test('ownedBy: a folder name is not a string prefix', () => {
  // the bug this guards: `src/main` must not swallow `src/mainframe.ts`
  assert.equal(ownedBy('src/mainframe.ts', ['src/main']), false)
  assert.equal(ownedBy('src/main-old/x.ts', ['src/main']), false)
})

test('ownedBy: Windows separators and stray trailing slashes still match', () => {
  assert.equal(ownedBy('src\\main\\git.ts', ['src/main']), true)
  assert.equal(ownedBy('src/main/git.ts', ['src\\main']), true)
  assert.equal(ownedBy('src/main/git.ts', ['src/main/']), true)
  assert.equal(ownedBy('src/main/git.ts', ['./src/main']), true)
})

test('a file nobody was granted is flagged as outside the scope', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['src/main/ratelimit.ts'], doneWhen: 'npm test passes', report: '9 tests pass' })], {
    files: ['src/main/ratelimit.ts', 'package.json']
  })
  const r = reviewReady(s)!
  assert.deepEqual(r.flags, [{ path: 'package.json', outside: true, why: 'changes dependencies' }])
  assert.equal(r.clean, false)
})

test('a file that is both outside the scope and sensitive is one flag, not two', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['src/main'], doneWhen: 'ok', report: 'ok' })], {
    files: ['src/main/a.ts', 'package.json', '.github/workflows/release.yml']
  })
  const r = reviewReady(s)!
  assert.equal(r.flags.length, 2)
  assert.deepEqual(
    r.flags.map((f) => f.path),
    ['package.json', '.github/workflows/release.yml']
  )
  assert.deepEqual(r.flags[0], { path: 'package.json', outside: true, why: 'changes dependencies' })
})

test('outside-the-scope files sort ahead of the merely sensitive ones', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['package.json', 'src'], doneWhen: 'ok', report: 'ok' })], {
    // package.json is granted (sensitive only); the workflow is not (outside, and sensitive)
    files: ['package.json', '.github/workflows/release.yml']
  })
  const r = reviewReady(s)!
  assert.deepEqual(
    r.flags.map((f) => [f.path, f.outside]),
    [
      ['.github/workflows/release.yml', true],
      ['package.json', false]
    ]
  )
})

test('a sensitive file somebody was granted does not make the review unclean', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['package.json'], doneWhen: 'ok', report: 'ok' })], { files: ['package.json'] })
  const r = reviewReady(s)!
  assert.deepEqual(r.flags, [{ path: 'package.json', outside: false, why: 'changes dependencies' }])
  assert.equal(r.clean, true)
})

test('a diff entirely inside the granted scope, with every claim merged, is clean', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['src/main/ratelimit.ts', 'test/unit'], doneWhen: 'npm test passes', report: 'all green' })], {
    files: ['src/main/ratelimit.ts', 'test/unit/ratelimit.test.ts']
  })
  const r = reviewReady(s)!
  assert.deepEqual(r.flags, [])
  assert.equal(r.clean, true)
  assert.deepEqual(
    r.claims.map((c) => [c.who, c.proven]),
    [['Nadia', true]]
  )
})

test('a claim is unproven, with the reason, when the worker never got merged', () => {
  const s = fleet(
    [
      member({ id: 'w1', name: 'Nadia', owns: ['a'], doneWhen: 'tests pass', status: 'working' }),
      member({ id: 'w2', name: 'Bo', owns: ['b'], doneWhen: 'lint passes', status: 'reported', report: 'done' }),
      member({ id: 'w3', name: 'Cy', owns: ['c'], doneWhen: 'it builds', status: 'closed' })
    ],
    { files: ['a', 'b', 'c'] }
  )
  const r = reviewReady(s)!
  assert.deepEqual(
    r.claims.map((c) => [c.who, c.gap]),
    [
      ['Nadia', 'still working'],
      ['Bo', 'reported but not merged'],
      ['Cy', 'never reported']
    ]
  )
  assert.equal(r.clean, false)
})

test('sensitive paths are flagged whoever owns them', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['.github', 'package.json', 'db', 'src'], doneWhen: 'ok', report: 'ok' })], {
    files: ['package.json', '.github/workflows/release.yml', 'db/migrations/003_add.sql', 'src/plain.ts']
  })
  const r = reviewReady(s)!
  assert.deepEqual(r.flags, [
    // all granted, so none is outside — and still worth a look
    { path: 'package.json', outside: false, why: 'changes dependencies' },
    { path: '.github/workflows/release.yml', outside: false, why: 'changes CI' },
    { path: 'db/migrations/003_add.sql', outside: false, why: 'looks like a database migration' }
  ])
})

test('a team that granted nothing is not reported as reaching outside its scope', () => {
  // a lone lead with no crew owns nothing on paper; every file would otherwise read as unowned
  const s = fleet([], { files: ['src/a.ts', 'src/b.ts'] })
  const r = reviewReady(s)!
  assert.deepEqual(r.flags, [])
  assert.deepEqual(r.claims, [])
  assert.equal(r.clean, true)
})

test('reviewers carry no claim and own nothing', () => {
  const s = fleet([member({ id: 'rv', name: 'Rex', role: 'reviewer', status: 'closed' }), member({ id: 'w1', name: 'Nadia', owns: ['src'], doneWhen: 'ok', report: 'ok' })], {
    files: ['src/a.ts']
  })
  const r = reviewReady(s)!
  assert.deepEqual(
    r.claims.map((c) => c.who),
    ['Nadia']
  )
})

test('no Ready card, nothing to review', () => {
  assert.equal(reviewReady(emptyFleet('p', '/repo')), null)
})

test('stalled: only members still going without a report, past the threshold, worst first', () => {
  const s = emptyFleet('p', '/repo')
  const now = 60 * 60000
  s.members = Object.fromEntries(
    [
      member({ id: 'slow', name: 'Nadia', status: 'working', createdAt: 0 }),
      member({ id: 'newer', name: 'Bo', status: 'working', createdAt: 50 * 60000 }),
      member({ id: 'fresh', name: 'Cy', status: 'working', createdAt: 59 * 60000 }),
      member({ id: 'spoke', name: 'Di', status: 'working', createdAt: 0, report: 'got there' }),
      member({ id: 'done', name: 'Eve', status: 'merged', createdAt: 0 })
    ].map((m) => [m.id, m])
  )
  assert.deepEqual(
    stalled(s, now, 10).map((x) => x.who),
    ['Nadia', 'Bo']
  )
  assert.deepEqual(stalled(s, now, 90), [])
})
