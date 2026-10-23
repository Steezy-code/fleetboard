// Repo knowledge on the board: kept with the project, read again when stale, learned by one model pass
// only when asked — and read by the two things that brief an agent, the charter and Oracle.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCharter } from '@shared/charter'
import { type KnowledgeFact, type RepoKnowledge, emptyKnowledge } from '@shared/knowledge'

const { useApp } = await import('@/state/store')
const { READ_EVERY_MS, READ_TIMEOUT_MS, currentKnowledge, forgetReadsForTest, learnKnowledge, refreshKnowledge } = await import('@/fleet/knowledge')
const { CHARTER_FIELDS, citeKnownCheck, draftCharter, gateCharter, useCharter, verifyEvidence } = await import('@/fleet/charter')
const { boardContext } = await import('@/voice/helm/context')
const { helmPrompt } = await import('@/voice/helm/helm')

const project = (id = 'p', extras: Record<string, unknown> = {}) =>
  useApp.setState({ project: { schema: 1, id, name: id, path: `/tmp/${id}`, activeWorkspaceId: 'w', lastOpened: 0, extras, workspaces: [] } as any })

const fact = (key: string, provenance: KnowledgeFact['provenance'], extra: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  key,
  topic: key.split('.')[0] as KnowledgeFact['topic'],
  text: `${key} text`,
  provenance,
  at: 1,
  ...extra
})
const NPM_TEST = fact('checks.test', 'repo', { text: '`npm test` runs the unit tests', source: 'package.json', command: 'npm test' })
const reading = (facts: KnowledgeFact[] = [NPM_TEST], docs: string[] = ['README.md']) => ({ facts, docs })
const knowing = (...facts: KnowledgeFact[]): RepoKnowledge => ({ ...emptyKnowledge(), facts })
const extrasOf = (id = 'p') => (useApp.getState().project?.id === id ? useApp.getState().project?.extras : undefined)

/** Wait for the gate to put a charter up, then take it down: what was shown is what is asserted on. */
async function shown(p: Promise<unknown>) {
  // a read that never answers holds the gate up to its timeout, and no longer
  const until = Date.now() + READ_TIMEOUT_MS + 1500
  while (!useCharter.getState().pending && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
  const c = useCharter.getState().pending
  assert.ok(c, 'the gate put a charter up')
  useCharter.getState().dismiss()
  await p
  return c
}

beforeEach(() => {
  ipc.reset()
  forgetReadsForTest()
  useApp.setState({ project: null })
})

// ---------------------------------------------------------------- kept with the board

test('a read of the repo lands in the board’s own state', async () => {
  project()
  ipc.handle('knowledge:read', () => reading())
  const k = await refreshKnowledge()
  assert.equal(k.facts[0]?.command, 'npm test')
  assert.equal((extrasOf()?.knowledge as RepoKnowledge).facts[0]?.key, 'checks.test')
  assert.deepEqual(ipc.callsTo('knowledge:read'), [['/tmp/p']])
})

test('read once in a while, not on every call, unless forced', async () => {
  project()
  ipc.handle('knowledge:read', () => reading())
  await Promise.all([refreshKnowledge(), refreshKnowledge()])
  await refreshKnowledge()
  assert.equal(ipc.callsTo('knowledge:read').length, 1, `within ${READ_EVERY_MS}ms one read serves everyone`)
  await refreshKnowledge(true)
  assert.equal(ipc.callsTo('knowledge:read').length, 2)
})

test('a read that finds what is already known does not touch the board', async () => {
  project('p', { knowledge: knowing(NPM_TEST) })
  const before = useApp.getState().project
  ipc.handle('knowledge:read', () => reading([{ ...NPM_TEST, at: 99 }]))
  await refreshKnowledge()
  assert.equal(useApp.getState().project, before, 'no change, so no save')
})

test('a read that never answers is given up on, with the knowledge as it was', async (t) => {
  project('p', { knowledge: knowing(NPM_TEST) })
  ipc.handle('knowledge:read', () => new Promise(() => {}))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = refreshKnowledge()
  t.mock.timers.tick(READ_TIMEOUT_MS)
  assert.deepEqual((await p).facts.map((f) => f.key), ['checks.test'])
})

test('a repo that cannot be read is no knowledge, not an error, and is tried again next time', async () => {
  project()
  ipc.handle('knowledge:read', () => {
    throw new Error('outside the allowed folders')
  })
  assert.deepEqual((await refreshKnowledge()).facts, [])
  ipc.handle('knowledge:read', () => null)
  await refreshKnowledge()
  assert.equal(ipc.callsTo('knowledge:read').length, 2, 'a failed read is not counted as a read')
})

// Review Focus 6
test('a read whose board closed or changed meanwhile writes nothing', async () => {
  project('p')
  let settle: (r: unknown) => void = () => {}
  ipc.handle('knowledge:read', () => new Promise((r) => (settle = r)))
  const p = refreshKnowledge()
  project('q')
  settle(reading())
  assert.deepEqual((await p).facts, [], 'what it read was not for this board')
  assert.equal(extrasOf('q')?.knowledge, undefined)
})

test('a model pass whose board changed meanwhile keeps nothing', async () => {
  project('p')
  ipc.handle('knowledge:read', () => reading([]))
  let settle: (r: unknown) => void = () => {}
  ipc.handle('cli:run', () => new Promise((r) => (settle = r)))
  const run = learnKnowledge()
  for (let i = 0; i < 50 && !ipc.callsTo('cli:run').length; i++) await new Promise((r) => setTimeout(r, 1))
  project('q')
  settle({ code: 0, text: JSON.stringify({ facts: [{ topic: 'style', text: 'two spaces' }] }) })
  const r = await run.promise
  assert.equal(r.ok, false)
  assert.equal(extrasOf('q')?.knowledge, undefined)
})

// ---------------------------------------------------------------- the model pass

test('a model pass adds its facts as inferred or readme, through the planner CLI, and leaves yours alone', async () => {
  const mine = fact('done.changelog', 'you', { text: 'Every change gets a changelog line' })
  project('p', { knowledge: knowing(mine) })
  useApp.setState({ settings: { ...useApp.getState().settings, plannerAgent: 'codex' } })
  ipc.handle('knowledge:read', () => reading())
  ipc.handle('cli:run', () => ({
    code: 0,
    text: JSON.stringify({
      facts: [
        { topic: 'done', key: 'changelog', text: 'No changelog is kept', source: 'README.md', fromReadme: true },
        { topic: 'style', key: 'voice', text: 'Comments explain why', source: 'README.md', fromReadme: true },
        { topic: 'ownership', key: 'gen', text: 'src/gen is generated', provenance: 'repo' }
      ]
    })
  }))
  const r = await learnKnowledge().promise
  assert.deepEqual(r, { ok: true, added: 2 })
  const k = currentKnowledge()
  const by = Object.fromEntries(k.facts.map((f) => [f.key, f]))
  assert.equal(by['done.changelog']?.text, 'Every change gets a changelog line', 'yours wins')
  assert.equal(by['style.voice']?.provenance, 'readme')
  assert.equal(by['ownership.gen']?.provenance, 'inferred', 'the model does not get to say it read the repo')
  assert.equal(by['checks.test']?.provenance, 'repo', 'and the read came first')
  assert.ok(k.learnedAt)
  const req = ipc.callsTo('cli:run')[0]?.[0] as any
  assert.equal(req.cwd, '/tmp/p')
  assert.equal(req.agentId, 'codex', 'the user’s own planner')
  assert.match(req.prompt, /Read README\.md first/)
  assert.match(req.prompt, /fact:done\.changelog/, 'it is told what is known, so it does not repeat it')
})

test('a model pass that fails keeps what the read found, and says why', async () => {
  project()
  ipc.handle('knowledge:read', () => reading())
  ipc.handle('cli:run', () => ({ code: 1, text: 'Error\nInvalid API key · Please run /login' }))
  const r = await learnKnowledge().promise
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Invalid API key · Please run /login')
  assert.deepEqual(currentKnowledge().facts.map((f) => f.key), ['checks.test'])
  assert.equal(currentKnowledge().learnedAt, undefined)
})

test('a model pass can be stopped, and keeps nothing', async () => {
  project()
  ipc.handle('knowledge:read', () => reading([]))
  let settle: (r: unknown) => void = () => {}
  ipc.handle('cli:run', () => new Promise((r) => (settle = r)))
  const run = learnKnowledge()
  for (let i = 0; i < 50 && !ipc.callsTo('cli:run').length; i++) await new Promise((r) => setTimeout(r, 1))
  run.cancel()
  settle({ code: 0, text: '{"facts":[{"topic":"style","text":"two spaces"}]}' })
  assert.equal((await run.promise).ok, false)
  assert.equal(ipc.callsTo('cli:cancel').length, 1)
  assert.deepEqual(currentKnowledge().facts, [])
})

// ---------------------------------------------------------------- the charter cites it

test('an assumption citing a fact read from the repo is known, with the fact as its citation', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'npm test is the check', known: true, from: 'fact:checks.test' }], wontTouch: ['x'], doneWhen: 'npm test' }, 'r')
  const v = verifyEvidence(c, () => false, knowing(NPM_TEST))
  assert.deepEqual(v.assumptions, [{ text: 'npm test is the check', known: true, from: 'package.json', fact: 'checks.test' }])
  assert.equal(v.confidence, 100)
})

// Review Focus 3
test('citing an inferred fact, a deleted one, or one that is not there is a guess', () => {
  const k = knowing(fact('done.green', 'inferred'))
  const c = coerceCharter(
    {
      understood: 'u',
      assumptions: [
        { text: 'a', known: true, from: 'fact:done.green' },
        { text: 'b', known: true, from: 'fact:checks.nope' }
      ]
    },
    'r'
  )
  assert.deepEqual(verifyEvidence(c, () => true, k).assumptions, [
    { text: 'a', known: false },
    { text: 'b', known: false }
  ])
})

// Review Focus 4
test('a fact the model wrote on an assumption itself is not believed', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'src/missing.ts', fact: 'checks.test' }] }, 'r')
  const v = verifyEvidence(c, () => false, knowing(NPM_TEST))
  assert.deepEqual(v.assumptions, [{ text: 'a', known: false }], 'checked as the path it cites, which is not there')
  const there = verifyEvidence(c, () => true, knowing(NPM_TEST))
  assert.deepEqual(there.assumptions, [{ text: 'a', known: true, from: 'src/missing.ts' }], 'and a path that is there keeps no fact it did not earn')
})

test('a done-when the repo was read to have is a known line the model did not have to write', () => {
  const c = coerceCharter({ understood: 'u', doneWhen: 'npm test && npm run lint' }, 'r')
  const k = knowing(NPM_TEST, fact('checks.lint', 'inferred', { command: 'npm run lint' }))
  const cited = citeKnownCheck(c, k)
  assert.deepEqual(cited.assumptions, [{ text: '`npm test` is one of this repo’s own checks', known: true, from: 'fact:checks.test' }], 'not the inferred one')
  const again = citeKnownCheck(verifyEvidence(cited, () => false, k), k)
  assert.equal(again.assumptions.length, 1, 'and not twice')
  assert.equal(citeKnownCheck(coerceCharter({ understood: 'u', doneWhen: 'make check' }, 'r'), k).assumptions.length, 0)
})

test('the same request scores higher in a repo whose checks are known', async () => {
  const draft = { understood: 'Add a split command', assumptions: [{ text: 'tests go in test/', known: false }], wontTouch: ['src/renderer'], doneWhen: 'npm test' }
  project('bare')
  ipc.handle('knowledge:read', () => null)
  const without = await shown(gateCharter(coerceCharter(draft, 'add split')))
  forgetReadsForTest()
  project('known')
  ipc.handle('knowledge:read', () => reading())
  const withIt = await shown(gateCharter(coerceCharter(draft, 'add split')))
  assert.ok(withIt.confidence > without.confidence, `${withIt.confidence} > ${without.confidence}`)
  assert.equal(withIt.assumptions.at(-1)?.fact, 'checks.test')
})

test('a goal in a repo with no knowledge, and one that cannot be read, still reaches the gate', async () => {
  project()
  ipc.handle('knowledge:read', () => new Promise(() => {}))
  const c = await shown(gateCharter(coerceCharter({ understood: 'u', doneWhen: 'npm test' }, 'r')))
  assert.equal(c.understood, 'u')
})

test('the draft prompt carries the facts, and the fragment says how to cite one', async () => {
  project('p', { knowledge: knowing(NPM_TEST, fact('done.green', 'inferred')) })
  ipc.handle('cli:run', () => ({ code: 0, text: '{}' }))
  await draftCharter('add split')
  const prompt = (ipc.callsTo('cli:run')[0]?.[0] as any).prompt as string
  assert.match(prompt, /fact:checks\.test \(read from the repo, package\.json\)/)
  assert.match(prompt, /fact:done\.green \(inferred — not evidence/)
  assert.match(CHARTER_FIELDS, /"fact:" and that fact's key/)
  assert.match(CHARTER_FIELDS, /inferred is not evidence/)
})

test('a repo with nothing known drafts the prompt it always did', async () => {
  project()
  ipc.handle('cli:run', () => ({ code: 0, text: '{}' }))
  await draftCharter('add split')
  assert.doesNotMatch((ipc.callsTo('cli:run')[0]?.[0] as any).prompt, /Known about this repo/)
})

// ---------------------------------------------------------------- Oracle reads it

test('Oracle’s snapshot carries what is known, keys and provenance and all', async () => {
  project('p', { knowledge: knowing(fact('ownership.src-main', 'you', { text: 'Luke owns src/main' })) })
  ipc.handle('knowledge:read', () => reading())
  const ctx = await boardContext()
  assert.match(ctx, /KNOWN ABOUT THIS REPO/)
  assert.match(ctx, /fact:ownership\.src-main \(from you\): Luke owns src\/main/)
  assert.match(ctx, /fact:checks\.test \(read from the repo, package\.json\)/, 'read fresh for the question')
  assert.ok(ctx.indexOf('KNOWN ABOUT') < ctx.indexOf('CONSOLES'), 'ahead of the console tails that are cut first')
})

test('with nothing known, the snapshot says so rather than leaving the section out', async () => {
  project()
  assert.match(await boardContext(), /KNOWN ABOUT THIS REPO \(cite one as fact:<key>\)\nnothing yet/)
})

test('Oracle can open the panel and is pointed at the facts for its charter', () => {
  const prompt = helmPrompt('x', 'board')
  assert.match(prompt, /\|knowledge\|/)
  assert.match(prompt, /what is already known about it is under KNOWN ABOUT THIS REPO/)
})

// ---------------------------------------------------------------- every charter edit is kept

test('confirming an edited charter keeps each changed field as a delta, with the request', async () => {
  project()
  const p = gateCharter(coerceCharter({ understood: 'Add a split command', wontTouch: ['src/renderer'], doneWhen: 'npm test', question: { text: 'Which split?', options: ['pages'] } }, 'add split'))
  for (let i = 0; i < 300 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
  useCharter.getState().edit({ understood: 'Add a split command — by pages.', question: undefined, ambiguity: undefined })
  useCharter.getState().edit({ doneWhen: 'npm test && npm run lint' })
  useCharter.getState().confirm()
  await p
  const deltas = currentKnowledge().deltas
  assert.deepEqual(
    deltas.map((d) => d.field),
    ['understood', 'doneWhen', 'question']
  )
  assert.ok(deltas.every((d) => d.request === 'add split'))
  assert.deepEqual(deltas[0], { at: deltas[0]!.at, request: 'add split', field: 'understood', before: 'Add a split command', after: 'Add a split command — by pages.' })
})

test('a charter confirmed as shown, or dismissed after edits, records nothing', async () => {
  project()
  const first = gateCharter(coerceCharter({ understood: 'u' }, 'r'))
  for (let i = 0; i < 300 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
  useCharter.getState().confirm()
  await first
  const second = gateCharter(coerceCharter({ understood: 'u' }, 'r'))
  for (let i = 0; i < 300 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
  useCharter.getState().edit({ understood: 'something else' })
  useCharter.getState().dismiss()
  await second
  assert.deepEqual(currentKnowledge().deltas, [])
  assert.equal(extrasOf()?.knowledge, undefined, 'and the board was not touched')
})

test('what the gate itself changed before the user saw it is not counted as their edit', async () => {
  project()
  ipc.handle('knowledge:read', () => reading())
  // the gate adds the known-check line and downgrades the uncited claim; neither is the user's doing
  const p = gateCharter(coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'nope.ts' }], doneWhen: 'npm test' }, 'r'))
  for (let i = 0; i < 300 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
  useCharter.getState().confirm()
  await p
  assert.deepEqual(currentKnowledge().deltas, [])
})
