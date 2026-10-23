// The pre-merge review is the last thing between an agent's branch and the user's checkout, so the
// two ways it can lie both matter: calling a diff in-scope when it reached outside the files the
// worker was granted, and calling a claim proven when no worker ever reported it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyFleet, type FleetMember, type FleetReady, type FleetState } from '../../src/shared/fleet'
import { coerceCharter } from '../../src/shared/charter'
import { excludedBy, ownedBy, reviewReady, stalled } from '../../src/shared/mergeReview'

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

function fleet(members: FleetMember[], ready: Partial<FleetReady> & { files: string[] }, wontTouch?: string[]): FleetState {
  const s = emptyFleet('p', '/repo')
  if (wontTouch) s.charter = coerceCharter({ understood: 'the job', wontTouch, doneWhen: 'npm test' }, 'the job', 1)
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

// ---- the charter's "won't touch": what the user ruled out, held against what the diff touched

test('an empty exclusion list excludes nothing', () => {
  assert.equal(excludedBy('src/main/pty.ts', []), null)
  assert.equal(excludedBy('src/main/pty.ts', undefined), null)
  assert.equal(excludedBy('src/main/pty.ts', ['']), null)
})

test('exclusions match however the model wrote the path', () => {
  for (const pattern of ['src/renderer', 'src/renderer/', './src/renderer', 'src\\renderer', 'src/renderer/*']) {
    assert.ok(excludedBy('src/renderer/src/App.tsx', [pattern]), `${pattern} should match`)
  }
  assert.ok(excludedBy('src\\renderer\\src\\App.tsx', ['src/renderer']), 'a backslash path from the file side too')
})

test('an exclusion matches a file, a folder and a star prefix, and nothing outside them', () => {
  assert.equal(excludedBy('src/main/pty.ts', ['src/main/pty.ts']), 'src/main/pty.ts')
  assert.equal(excludedBy('src/main/pty.ts', ['src/main']), 'src/main')
  assert.equal(excludedBy('src/main/pty.ts', ['src/main/*']), 'src/main/*')
  assert.equal(excludedBy('src/mainframe/x.ts', ['src/main/']), null)
  assert.equal(excludedBy('src/main-old/x.ts', ['src/main']), null)
  assert.equal(excludedBy('src/main/pty.ts', ['src/main/pty.tsx']), null)
})

test('the exclusion that matched comes back as it was written, whichever entry it was', () => {
  // the Lead is told which of the user's lines a file broke, so it has to be that line, not a tidied copy
  assert.equal(excludedBy('src/renderer/a.ts', ['docs', './src/renderer/', 'src']), './src/renderer/')
})

// An exclusion that matches nothing is worse than no exclusion: the card says the folder is out of
// bounds, the user agrees to that, and nothing holds anyone to it. These two forms are what a model
// writes when it means the folder, so they are read as the folder rather than failing open.
test('a leading slash and a ** tail still exclude the folder they name', () => {
  for (const entry of ['/src/renderer', '//src/renderer', '/src/renderer/', 'src/renderer/**', 'src/renderer/**/*', '/src/renderer/**']) {
    assert.equal(excludedBy('src/renderer/a.ts', [entry]), entry, `${entry} must exclude a file under it`)
  }
  assert.equal(excludedBy('src/renderertop.ts', ['/src/renderer']), null, 'and still not a string prefix')
  assert.equal(excludedBy('docs/a.md', ['src/renderer/**']), null)
})

// The other direction: an exclusion that matches *everything* is not a rule the user read either —
// a charter carrying it would refuse every merge, over a line one character long.
test('an exclusion that is nothing but a wildcard excludes nothing at all', () => {
  // `/./*`, `//./*` and the backslash spelling each reached `covers` as `./*`, which it normed back
  // to a bare `*`: every path excluded, every merge refused, and no way to edit the charter after a
  // team has started.
  for (const entry of ['*', '**', '/*', './*', '/**', '*/', '/./*', '//./*', '\\.\\*', '/.//*'] as const) {
    for (const file of ['src/a.ts', 'package.json', 'docs/deep/x.md']) assert.equal(excludedBy(file, [entry]), null, `${entry} vs ${file}`)
  }
  assert.equal(excludedBy('src/a.ts', ['*', 'src']), 'src', 'a real entry beside it still matches')
})

// None of the above is `owns`: a grant that matches nothing only over-flags, which is the safe way
// round, and "everything" there plausibly means everything. Changing it would change which files the
// review calls out of scope.
test('ownedBy reads the same strings exactly as it did', () => {
  assert.equal(ownedBy('src/a.ts', ['*']), true)
  assert.equal(ownedBy('package.json', ['*']), true)
  assert.equal(ownedBy('src/renderer/a.ts', ['/src/renderer']), false)
  assert.equal(ownedBy('src/renderer/a.ts', ['src/renderer/**']), false)
  assert.equal(ownedBy('src/renderer/a.ts', ['src/renderer/**/*']), false)
  assert.equal(ownedBy('src/renderer/a.ts', ['**']), false)
})

test('an excluded file is flagged with its exclusion and blocks the review', () => {
  // the worker owns src, so the file is inside its scope and is not sensitive: the exclusion alone has to raise it
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['src'], doneWhen: 'ok', report: 'ok' })], { files: ['src/main/a.ts', 'src/renderer/src/App.tsx'] }, ['src/renderer/'])
  const r = reviewReady(s)!
  assert.equal(r.blocked, true)
  assert.deepEqual(r.flags, [{ path: 'src/renderer/src/App.tsx', outside: false, excluded: 'src/renderer/' }])
  assert.equal(r.clean, false)
})

test('a file that is excluded, outside the scope and sensitive is still one flag', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['src'], doneWhen: 'ok', report: 'ok' })], { files: ['package.json'] }, ['package.json'])
  assert.deepEqual(reviewReady(s)!.flags, [{ path: 'package.json', outside: true, excluded: 'package.json', why: 'changes dependencies' }])
})

test('excluded files sort ahead of outside-the-scope ones, which sort ahead of the merely sensitive', () => {
  const s = fleet(
    [member({ id: 'w1', name: 'Nadia', owns: ['package.json', 'src'], doneWhen: 'ok', report: 'ok' })],
    // sensitive and granted, then outside and sensitive, then granted and excluded — the reverse of the order wanted
    { files: ['package.json', '.github/workflows/release.yml', 'src/renderer/a.ts'] },
    ['src/renderer']
  )
  assert.deepEqual(
    reviewReady(s)!.flags.map((f) => f.path),
    ['src/renderer/a.ts', '.github/workflows/release.yml', 'package.json']
  )
})

test('a merely sensitive file does not block', () => {
  const s = fleet([member({ id: 'w1', name: 'Nadia', owns: ['package.json'], doneWhen: 'ok', report: 'ok' })], { files: ['package.json'] }, ['src/renderer'])
  const r = reviewReady(s)!
  assert.equal(r.flags.length, 1)
  assert.equal(r.blocked, false)
  assert.equal(r.clean, true)
})

test('a board with no charter, or a charter that rules nothing out, is never blocked', () => {
  const files = ['src/renderer/a.ts']
  for (const wontTouch of [undefined, []]) {
    const r = reviewReady(fleet([member({ id: 'w1', name: 'Nadia', owns: ['src'], doneWhen: 'ok', report: 'ok' })], { files }, wontTouch))!
    assert.equal(r.blocked, false)
    assert.deepEqual(r.flags, [])
    assert.equal(r.clean, true)
  }
})

test('stalled: members still going that have gone quiet, past the threshold, quietest first', () => {
  const s = emptyFleet('p', '/repo')
  const now = 60 * 60000
  s.members = Object.fromEntries(
    [
      member({ id: 'quiet', name: 'Nadia', status: 'working', createdAt: 0, lastOutputAt: 20 * 60000 }),
      member({ id: 'quieter', name: 'Bo', status: 'working', createdAt: 50 * 60000 }),
      member({ id: 'talking', name: 'Cy', status: 'working', createdAt: 0, lastOutputAt: 58 * 60000 }),
      member({ id: 'spoke', name: 'Di', status: 'working', createdAt: 0, report: 'got there' }),
      member({ id: 'done', name: 'Eve', status: 'merged', createdAt: 0 })
    ].map((m) => [m.id, m])
  )
  assert.deepEqual(
    stalled(s, now, 5).map((x) => [x.who, x.minutes]),
    [
      ['Nadia', 40],
      ['Bo', 10]
    ]
  )
  assert.deepEqual(stalled(s, now, 90), [])
})

test('a member an hour old but still printing is not stalled: silence is what counts, not age', () => {
  const s = emptyFleet('p', '/repo')
  s.members = { old: member({ id: 'old', name: 'Old', status: 'working', createdAt: 0, lastOutputAt: 59 * 60000 }) }
  assert.deepEqual(stalled(s, 60 * 60000), [])
})

// Review Focus 4
test('silence is not counted from before the app was watching', () => {
  const s = emptyFleet('p', '/repo')
  s.members = { m: member({ id: 'm', name: 'Ada', status: 'working', createdAt: 0, lastOutputAt: 60000 }) }
  const restart = 100 * 60000
  assert.deepEqual(stalled(s, restart + 2 * 60000, 5, restart), [], 'two minutes since the restart')
  assert.deepEqual(stalled(s, restart + 6 * 60000, 5, restart).map((x) => x.minutes), [6])
})
