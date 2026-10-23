// Repo knowledge: what a fact is, who may say where it came from, and what a rebuild may and may not
// change. The property everything else rests on is that the user wins — a fact they corrected or
// deleted stays that way — because a wrong fact nobody can argue with poisons every charter after it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCharter } from '@shared/charter'
import {
  type CharterDelta,
  type KnowledgeFact,
  type RepoKnowledge,
  addFact,
  charterDeltas,
  citable,
  coerceKnowledge,
  coerceLearned,
  confirmFact,
  editFact,
  forgetFact,
  knowledgeBlock,
  mergeFacts,
  rememberCorrection,
  repeatedCorrections,
  withDeltas
} from '@shared/knowledge'

const fact = (key: string, provenance: KnowledgeFact['provenance'], text = key, extra: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  key,
  topic: key.split('.')[0] as KnowledgeFact['topic'],
  text,
  provenance,
  at: 1,
  ...extra
})
const empty = (): RepoKnowledge => coerceKnowledge(undefined)
const texts = (k: RepoKnowledge) => Object.fromEntries(k.facts.map((f) => [f.key, `${f.provenance}:${f.text}`]))

// ---------------------------------------------------------------- provenance

// Review Focus 1
test('a model cannot claim a fact was read from the repo or written by the user', () => {
  const facts = coerceLearned(
    {
      facts: [
        { topic: 'style', key: 'tabs', text: 'Tabs, not spaces', provenance: 'repo' },
        { topic: 'style', key: 'mine', text: 'Use semicolons', provenance: 'you' }
      ]
    },
    ['README.md']
  )
  assert.deepEqual(
    facts.map((f) => f.provenance),
    ['inferred', 'inferred']
  )
})

test('a readme fact needs a doc the inspection found', () => {
  const [a, b, c] = coerceLearned(
    {
      facts: [
        { topic: 'done', key: 'changelog', text: 'Every change gets a changelog line', source: 'README.md', fromReadme: true },
        { topic: 'done', key: 'docs', text: 'Docs are updated', source: 'NOTES.md', fromReadme: true },
        { topic: 'done', key: 'notes', text: 'Release notes are written', source: './docs\\guide.md', fromReadme: true }
      ]
    },
    ['README.md', 'docs/guide.md']
  )
  assert.equal(a?.provenance, 'readme')
  assert.equal(b?.provenance, 'inferred')
  assert.equal(c?.provenance, 'readme', 'however the model wrote the path')
  assert.equal(c?.source, 'docs/guide.md')
})

test('a model fact is keyed by its topic, and junk is dropped', () => {
  const facts = coerceLearned(
    {
      facts: [
        { topic: 'Ownership', key: 'Main Process!', text: 'Luke owns src/main' },
        { topic: 'weather', text: 'It is sunny' },
        { topic: 'style', text: '' },
        'not a fact',
        { topic: 'checks', text: 'The e2e suite runs under Xvfb', command: 'npm run test:e2e' }
      ]
    },
    []
  )
  assert.deepEqual(
    facts.map((f) => f.key),
    ['ownership.main-process', 'checks.the-e2e-suite-runs-under-xvfb']
  )
  assert.equal(facts[1]?.command, 'npm run test:e2e')
})

test('a reply that is not usable is no facts, not an error', () => {
  for (const raw of [null, undefined, 'prose', 42, {}, { facts: 'x' }]) assert.deepEqual(coerceLearned(raw, []), [])
  // a bare array is what a model sends when it forgets the wrapper; it is still what was asked for
  assert.equal(coerceLearned([{ topic: 'style', text: 'two spaces' }], []).length, 1)
})

// ---------------------------------------------------------------- who wins

// Review Focus 2
test('a fact you corrected survives a rebuild that read it again', () => {
  let k = mergeFacts(empty(), [fact('checks.npm-test', 'repo', '`npm test` runs the unit tests', { source: 'package.json', command: 'npm test' })], ['repo'])
  k = editFact(k, 'checks.npm-test', { text: '`npm test` runs unit tests only; e2e is separate' }, 5)
  const edited = k.facts[0]
  assert.equal(edited?.provenance, 'you')
  assert.equal(edited?.source, 'package.json', 'where it came from is kept')
  k = mergeFacts(k, [fact('checks.npm-test', 'repo', '`npm test` runs the unit tests')], ['repo'])
  assert.deepEqual(texts(k), { 'checks.npm-test': 'you:`npm test` runs unit tests only; e2e is separate' })
  k = mergeFacts(k, [fact('checks.npm-test', 'inferred', 'something else')], ['readme', 'inferred'])
  assert.deepEqual(texts(k), { 'checks.npm-test': 'you:`npm test` runs unit tests only; e2e is separate' }, 'and a model pass does not touch it either')
})

test('a fact you deleted is not brought back by either rebuild', () => {
  let k = mergeFacts(empty(), [fact('style.prettier', 'repo'), fact('done.changelog', 'inferred')], ['repo', 'inferred'])
  k = forgetFact(forgetFact(k, 'style.prettier'), 'done.changelog')
  assert.deepEqual(k.facts, [])
  k = mergeFacts(k, [fact('style.prettier', 'repo')], ['repo'])
  k = mergeFacts(k, [fact('done.changelog', 'inferred'), fact('style.prettier', 'readme')], ['readme', 'inferred'])
  assert.deepEqual(k.facts, [])
  assert.deepEqual([...k.forgotten].sort(), ['done.changelog', 'style.prettier'])
})

test('a rebuild replaces only its own kind of fact', () => {
  let k = mergeFacts(empty(), [fact('checks.npm-test', 'repo'), fact('checks.npm-run-lint', 'repo')], ['repo'])
  k = mergeFacts(k, [fact('done.green', 'inferred'), fact('style.voice', 'readme')], ['readme', 'inferred'])
  k = addFact(k, 'ownership', 'Luke reviews src/main', 9)
  // the lint script went away; the model's facts and yours are not the repo read's to remove
  k = mergeFacts(k, [fact('checks.npm-test', 'repo')], ['repo'])
  assert.deepEqual(
    k.facts.map((f) => f.key).sort(),
    ['checks.npm-test', 'done.green', 'ownership.you-9', 'style.voice']
  )
  // and a new model pass replaces the old model facts, and nothing else
  k = mergeFacts(k, [fact('done.typecheck', 'inferred')], ['readme', 'inferred'])
  assert.deepEqual(
    k.facts.map((f) => f.key).sort(),
    ['checks.npm-test', 'done.typecheck', 'ownership.you-9']
  )
})

test('read from the repo outranks the model on the same key', () => {
  let k = mergeFacts(empty(), [fact('checks.npm-test', 'repo', 'from the repo')], ['repo'])
  k = mergeFacts(k, [fact('checks.npm-test', 'inferred', 'from the model')], ['readme', 'inferred'])
  assert.deepEqual(texts(k), { 'checks.npm-test': 'repo:from the repo' })
  // and the other way round: a model fact already held gives way to the repo read
  let j = mergeFacts(empty(), [fact('checks.npm-test', 'inferred', 'from the model')], ['readme', 'inferred'])
  j = mergeFacts(j, [fact('checks.npm-test', 'repo', 'from the repo')], ['repo'])
  assert.deepEqual(texts(j), { 'checks.npm-test': 'repo:from the repo' })
})

test('confirming an inferred fact makes it yours, and so citable', () => {
  let k = mergeFacts(empty(), [fact('done.green', 'inferred', 'Done means the suite is green')], ['inferred'])
  assert.equal(citable(k, 'done.green'), undefined, 'an inferred fact is shown, not cited')
  k = confirmFact(k, 'done.green', 3)
  assert.equal(citable(k, 'done.green')?.provenance, 'you')
  assert.equal(citable(k, 'done.green')?.text, 'Done means the suite is green')
})

test('an edit that blanks a fact is not an edit', () => {
  const k = mergeFacts(empty(), [fact('style.tabs', 'repo', 'Tabs')], ['repo'])
  assert.deepEqual(editFact(k, 'style.tabs', { text: '   ' }), k)
  assert.deepEqual(addFact(k, 'style', '  '), k)
})

// ---------------------------------------------------------------- loading

// Review Focus 5
test('old or damaged state loads as whatever is usable', () => {
  for (const raw of [undefined, null, 'x', 42, [], { facts: 'no' }, { forgotten: 'no', deltas: {} }]) {
    const k = coerceKnowledge(raw)
    assert.deepEqual([k.facts, k.forgotten, k.deltas], [[], [], []], JSON.stringify(raw))
  }
  const k = coerceKnowledge({
    facts: [null, { key: 'checks.x' }, { key: 'checks.ok', topic: 'checks', text: 't', provenance: 'repo', at: 1 }, { key: 'k', topic: 'nope', text: 't', provenance: 'repo', at: 1 }],
    forgotten: ['style.a', 7],
    deltas: [{ at: 1, request: 'r', field: 'understood', before: 'a', after: 'b' }, { field: 'understood' }],
    readAt: 'yesterday'
  })
  assert.deepEqual(
    k.facts.map((f) => f.key),
    ['checks.ok']
  )
  assert.deepEqual(k.forgotten, ['style.a'])
  assert.equal(k.deltas.length, 1)
  assert.equal(k.readAt, undefined)
})

// ---------------------------------------------------------------- what the models are shown

test('the facts a model is shown carry their key and where they came from, inferred ones marked as not evidence', () => {
  const k = mergeFacts(
    empty(),
    [fact('checks.npm-test', 'repo', '`npm test` runs the unit tests', { source: 'package.json' }), fact('done.green', 'inferred', 'Done means green')],
    ['repo', 'inferred']
  )
  const b = knowledgeBlock(k)
  assert.match(b, /fact:checks\.npm-test .*read from the repo.*package\.json.*`npm test` runs the unit tests/)
  assert.match(b, /fact:done\.green .*inferred.*not evidence/i)
  assert.equal(knowledgeBlock(empty()), '', 'nothing known is nothing said')
})

test('a long list is cut to fit, keeping the facts a charter can cite first', () => {
  const many = Array.from({ length: 80 }, (_, i) => fact(`style.f${i}`, 'inferred', 'x'.repeat(60)))
  const k = mergeFacts(empty(), [...many, fact('checks.npm-test', 'repo', 'the check')], ['repo', 'inferred'])
  const b = knowledgeBlock(k, 800)
  assert.ok(b.length <= 800, `${b.length}`)
  assert.match(b, /fact:checks\.npm-test/)
})

// ---------------------------------------------------------------- charter edits

test('a charter edit is a typed delta per field, and an unedited charter has none', () => {
  const drafted = coerceCharter(
    { understood: 'Add a split command', assumptions: [{ text: 'tests in test/', known: false }], wontTouch: ['src/renderer'], doneWhen: 'npm test', question: { text: 'Which split?', options: ['pages'] } },
    'add split'
  )
  assert.deepEqual(charterDeltas(drafted, drafted), [])
  const confirmed = coerceCharter(
    { understood: 'Add a split command — by pages.', assumptions: [{ text: 'tests in test/unit', known: false }], wontTouch: ['src/renderer', 'src/main/fleet.ts'], doneWhen: 'npm test && npm run lint' },
    'add split'
  )
  const d = charterDeltas(drafted, confirmed, 7)
  assert.deepEqual(d, [
    { at: 7, request: 'add split', field: 'understood', before: 'Add a split command', after: 'Add a split command — by pages.' },
    { at: 7, request: 'add split', field: 'assumptions', added: ['tests in test/unit'], removed: ['tests in test/'] },
    { at: 7, request: 'add split', field: 'wontTouch', added: ['src/main/fleet.ts'], removed: [] },
    { at: 7, request: 'add split', field: 'doneWhen', before: 'npm test', after: 'npm test && npm run lint' },
    { at: 7, request: 'add split', field: 'question', before: 'Which split?', after: '' }
  ])
})

test('deltas are kept newest last and capped', () => {
  let k = empty()
  for (let i = 0; i < 260; i++) k = withDeltas(k, [{ at: i, request: 'r', field: 'understood', before: 'a', after: `b${i}` }])
  assert.equal(k.deltas.length, 200)
  assert.equal(k.deltas.at(-1)?.at, 259)
  assert.equal(withDeltas(k, []), k, 'nothing to keep changes nothing')
})

// ------------------------------------------------- a correction made more than once

const edit = (request: string, field: 'wontTouch' | 'doneWhen', value: string, at = 1): CharterDelta =>
  field === 'wontTouch' ? { at, request, field, added: [value], removed: [] } : { at, request, field, before: '', after: value }

test('a correction on one goal only is not a rule yet', () => {
  const k = withDeltas(empty(), [edit('add a split command', 'wontTouch', 'release/')])
  assert.deepEqual(repeatedCorrections(k), [])
})

test('the same exclusion on two goals is offered as a fact to keep', () => {
  const k = withDeltas(empty(), [edit('add a split command', 'wontTouch', 'release/', 1), edit('fix the merge gate', 'wontTouch', 'release/', 2)])
  const s = repeatedCorrections(k)
  assert.equal(s.length, 1)
  assert.equal(s[0]?.key, 'ownership.wont-touch-release')
  assert.equal(s[0]?.topic, 'ownership')
  assert.equal(s[0]?.times, 2)
  assert.equal(s[0]?.at, 2, 'dated from the last time it was corrected')
  assert.match(s[0]?.text ?? '', /release\//)
})

test('the same correction on one goal twice is still one goal', () => {
  const k = withDeltas(empty(), [edit('add a split command', 'wontTouch', 'release/', 1), edit('Add a split command ', 'wontTouch', 'release/', 2)])
  assert.deepEqual(repeatedCorrections(k), [])
})

test('a done-when set the same way twice becomes a check, with its command', () => {
  const k = withDeltas(empty(), [edit('one', 'doneWhen', 'npm test && npm run lint', 1), edit('two', 'doneWhen', 'npm test && npm run lint', 2)])
  const s = repeatedCorrections(k)
  assert.equal(s.length, 1)
  assert.equal(s[0]?.topic, 'checks')
  assert.equal(s[0]?.command, 'npm test && npm run lint')
})

test('a cleared field and an exclusion taken off are corrections of nothing', () => {
  const k = withDeltas(empty(), [
    { at: 1, request: 'one', field: 'doneWhen', before: 'npm test', after: '' },
    { at: 2, request: 'two', field: 'doneWhen', before: 'npm test', after: '' },
    { at: 3, request: 'one', field: 'wontTouch', added: [], removed: ['src/main'] },
    { at: 4, request: 'two', field: 'wontTouch', added: [], removed: ['src/main'] },
    { at: 5, request: 'one', field: 'understood', before: 'a', after: 'b' },
    { at: 6, request: 'two', field: 'understood', before: 'a', after: 'b' }
  ])
  assert.deepEqual(repeatedCorrections(k), [])
})

test('keeping a correction makes it a fact of yours, which a charter can cite', () => {
  const k = withDeltas(empty(), [edit('one', 'doneWhen', 'npm test', 1), edit('two', 'doneWhen', 'npm test', 2)])
  const s = repeatedCorrections(k)[0]
  assert.ok(s)
  const kept = rememberCorrection(k, s, 9)
  const f = kept.facts.find((x) => x.key === s.key)
  assert.equal(f?.provenance, 'you')
  assert.equal(f?.command, 'npm test')
  assert.equal(f?.at, 9)
  assert.ok(citable(kept, s.key), 'a kept correction is evidence')
  assert.deepEqual(repeatedCorrections(kept), [], 'and is not offered again')
})

test('a correction dismissed stays dismissed, and a rebuild cannot bring it back', () => {
  const k = withDeltas(empty(), [edit('one', 'wontTouch', 'release/', 1), edit('two', 'wontTouch', 'release/', 2)])
  const s = repeatedCorrections(k)[0]
  assert.ok(s)
  const no = forgetFact(k, s.key)
  assert.deepEqual(repeatedCorrections(no), [])
  const rebuilt = mergeFacts(no, [fact(s.key, 'inferred', 'the model says so')], ['inferred'])
  assert.equal(rebuilt.facts.find((x) => x.key === s.key), undefined)
})

test('the correction made most often comes first', () => {
  const k = withDeltas(empty(), [
    edit('one', 'wontTouch', 'docs/', 1),
    edit('two', 'wontTouch', 'docs/', 2),
    edit('one', 'wontTouch', 'release/', 3),
    edit('two', 'wontTouch', 'release/', 4),
    edit('three', 'wontTouch', 'release/', 5)
  ])
  assert.deepEqual(
    repeatedCorrections(k).map((s) => s.times),
    [3, 2]
  )
})
