// Where a charter comes from: the fragment both producers send, Oracle's team option carrying one,
// the standalone draft for a door that never consults Oracle, and the check that its evidence is real.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCharter } from '@shared/charter'
import { excludedBy } from '@shared/mergeReview'

const { useApp } = await import('@/state/store')
const { CHARTER_FIELDS, draftCharter, verifyEvidence } = await import('@/fleet/charter')
const { autoSafe, coerceResult, helmPrompt } = await import('@/voice/helm/helm')

const withProject = () =>
  useApp.setState({ project: { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [] } as any })

beforeEach(() => {
  ipc.reset()
  useApp.setState({ project: null })
})

// ---------------------------------------------------------------- the evidence check

test('an assumption citing a path that is not there becomes a guess, and confidence drops', () => {
  const c = coerceCharter(
    {
      understood: 'u',
      assumptions: [
        { text: 'tests live in test/', known: true, from: 'test/' },
        { text: 'commands are in src/main/cli.ts', known: true, from: 'src/main/cli.ts' }
      ],
      doneWhen: 'npm test'
    },
    'r'
  )
  const v = verifyEvidence(c, (p) => p === 'test/')
  assert.equal(v.assumptions[0]?.known, true)
  assert.equal(v.assumptions[1]?.known, false)
  assert.ok(v.confidence < c.confidence)
})

test('a downgraded assumption is the same shape a guess is, with the citation that failed gone', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'nope/' }] }, 'r')
  assert.deepEqual(verifyEvidence(c, () => false).assumptions, [{ text: 'a', known: false }])
})

test('a charter whose evidence all exists keeps its score, and the one passed in is not changed', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'src/' }], wontTouch: ['x'], doneWhen: 'npm test' }, 'r')
  const before = JSON.stringify(c)
  assert.equal(verifyEvidence(c, () => true).confidence, c.confidence)
  verifyEvidence(c, () => false)
  assert.equal(JSON.stringify(c), before)
})

test('"known" with nothing cited is not evidence, whatever built the charter', () => {
  const c = { ...coerceCharter({ understood: 'u' }, 'r'), assumptions: [{ text: 'a', known: true }] }
  assert.equal(verifyEvidence(c, () => true).assumptions[0]?.known, false)
})

// ---------------------------------------------------------------- the shared fragment

test('the charter prompt fragment is the same text both producers send', async () => {
  assert.ok(helmPrompt('x', 'board').includes(CHARTER_FIELDS))

  withProject()
  const sent: string[] = []
  ipc.handle('cli:run', (req: any) => {
    sent.push(req.prompt)
    return { code: 0, text: '{}' }
  })
  await draftCharter('x')
  assert.ok(sent[0]?.includes(CHARTER_FIELDS))
})

// What the merge gate matches is a path, a folder or a folder/* prefix. Prose or a glob matches
// nothing there and fails open — the card would say something was protected that is not.
test('the fragment asks for wontTouch in the forms the merge gate matches, and says what not to write', () => {
  const rule = CHARTER_FIELDS.split('\n').find((l) => l.startsWith('- wontTouch'))
  assert.ok(rule, 'the fragment has a wontTouch rule')
  for (const [entry, file] of [
    ['package.json', 'package.json'],
    ['src/renderer', 'src/renderer/App.tsx'],
    ['src/renderer/*', 'src/renderer/App.tsx']
  ] as const) {
    assert.ok(rule.includes(`"${entry}"`), `the rule shows ${entry}`)
    assert.equal(excludedBy(file, [entry]), entry, `${entry} really excludes ${file}`)
  }
  assert.match(rule, /glob/i)
  assert.match(rule, /description/i)
  assert.match(rule, /leading slash/i)
})

test('the fragment tells the model not to report a confidence number, and to ask at most one question', () => {
  assert.match(CHARTER_FIELDS, /confidence/i)
  assert.match(CHARTER_FIELDS, /at most one question/i)
  for (const kind of ['scope', 'acceptance', 'subject', 'constraint']) assert.ok(CHARTER_FIELDS.includes(kind), kind)
})

// ---------------------------------------------------------------- through Oracle

test('a team option carrying a charter keeps it through coercion', () => {
  const r = coerceResult({ reply: 'ok', options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'g', charter: { understood: 'u' } }] })
  assert.ok(r.options[0]?.charter)
  assert.equal(coerceCharter(r.options[0]?.charter, 'req').understood, 'u', 'it is the raw object, coerced where it is used')
})

test('a team option with no charter, or one that is not an object, carries none', () => {
  const r = coerceResult({
    reply: 'ok',
    options: [
      { kind: 'team', label: 'a', detail: 'd', goal: 'g' },
      { kind: 'team', label: 'b', detail: 'd', goal: 'g', charter: 'sure' },
      { kind: 'team', label: 'c', detail: 'd', goal: 'g', charter: ['x'] }
    ]
  })
  assert.equal(r.options.length, 3)
  for (const o of r.options) assert.equal('charter' in o, false)
})

test('a team option can never auto-run, charter or not', () => {
  assert.equal(autoSafe({ kind: 'team', label: 'l', detail: 'd', goal: 'g' }), false)
  assert.equal(autoSafe({ kind: 'team', label: 'l', detail: 'd', goal: 'g', charter: { understood: 'u' } }), false)
  const r = coerceResult({ reply: 'ok', auto: 0, options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'g', charter: { understood: 'u' } }] })
  assert.equal(r.auto, null)
})

// ---------------------------------------------------------------- a door that never consults Oracle

test('draftCharter costs one model call and returns the model\'s charter, coerced', async () => {
  withProject()
  ipc.handle('cli:run', () => ({
    code: 0,
    text: 'Here you go:\n```json\n' + JSON.stringify({ understood: 'Add a --json flag', assumptions: [{ text: 'flags live in cli.ts', known: true, from: 'src/main/cli.ts' }], wontTouch: ['src/renderer/*'], doneWhen: 'npm test', confidence: 99 }) + '\n```'
  }))
  const c = await draftCharter('add a json flag')
  assert.equal(ipc.callsTo('cli:run').length, 1)
  assert.equal(c.request, 'add a json flag')
  assert.equal(c.understood, 'Add a --json flag')
  assert.deepEqual(c.wontTouch, ['src/renderer/*'])
  assert.notEqual(c.confidence, 99, 'a confidence the model reports is not believed')
  assert.equal((ipc.callsTo('cli:run')[0]?.[0] as any).cwd, '/tmp/p', 'it runs in the project, so the model can look at the repo')
  assert.ok((ipc.callsTo('cli:run')[0]?.[0] as any).prompt.includes('"add a json flag"'), 'the request is in the prompt')
})

test('a reply with no JSON, or a CLI that fails, costs confidence and never the goal', async () => {
  withProject()
  const fallback = coerceCharter(null, 'fix the login bug')
  ipc.handle('cli:run', () => ({ code: 0, text: 'I would be happy to help with that.' }))
  assert.deepEqual({ ...(await draftCharter('fix the login bug')), at: 0 }, { ...fallback, at: 0 })
  ipc.handle('cli:run', () => {
    throw new Error('spawn claude ENOENT')
  })
  const failed = await draftCharter('fix the login bug')
  assert.deepEqual({ ...failed, at: 0 }, { ...fallback, at: 0 })
  assert.equal(failed.understood, 'fix the login bug', 'the goal itself comes through')
})

test('with no project open there is nothing to run in, and no call is made', async () => {
  const c = await draftCharter('fix the login bug')
  assert.equal(c.understood, 'fix the login bug')
  assert.equal(ipc.callsTo('cli:run').length, 0)
})
