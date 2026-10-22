// The charter: what a goal was understood to be, and the score that says how far to trust that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FULL_CARD_BELOW, charterBrief, coerceCharter, scoreConfidence } from '../../src/shared/charter'

test('confidence is the share of assumptions that cite evidence', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }, { text: 'c', known: false }], wontTouch: ['x'], doneWhen: 'npm test' }
  assert.equal(scoreConfidence(c), 67)
})

test('no done-when caps confidence, however many assumptions are known', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }], wontTouch: ['x'], doneWhen: '' }
  assert.equal(scoreConfidence(c), 60)
})

test('an open question keeps the card full', () => {
  const c = { assumptions: [{ text: 'a', known: true }], wontTouch: ['x'], doneWhen: 'npm test', question: { text: 'which?', options: ['a', 'b'] } }
  assert.ok(scoreConfidence(c) < 80)
})

test('no assumptions at all is not certainty', () => {
  // 50 for having shown no work, less 10 for naming nothing it will leave alone
  assert.equal(scoreConfidence({ assumptions: [], wontTouch: [], doneWhen: 'npm test' }), 40)
})

// Review Focus 1
test('a malformed reply still yields a charter carrying the request', () => {
  for (const raw of [null, undefined, 'not json', 42, [], {}]) {
    const c = coerceCharter(raw, 'add a split command')
    assert.equal(c.request, 'add a split command')
    assert.equal(c.understood, 'add a split command')
    assert.ok(c.confidence < 80, `${JSON.stringify(raw)} should not read as confident`)
    assert.deepEqual(c.assumptions, [])
  }
})

test('an assumption claiming known without citing evidence is downgraded to a guess', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'tests are in test/', known: true }], doneWhen: 'npm test' }, 'r')
  assert.equal(c.assumptions[0]?.known, false)
})

// Review Focus 4
test('an empty done-when is absent rather than an empty command', () => {
  const c = coerceCharter({ understood: 'u', doneWhen: '   ' }, 'r')
  assert.equal(c.doneWhen, '')
})

test('the brief the Lead gets carries the exclusions and the check', () => {
  const b = charterBrief(coerceCharter({ understood: 'Add a split subcommand', wontTouch: ['src/renderer/'], doneWhen: 'npm test' }, 'r'))
  assert.match(b, /Add a split subcommand/)
  assert.match(b, /src\/renderer\//)
  assert.match(b, /npm test/)
})

test('a field of the wrong type is dropped, not printed as text', () => {
  const c = coerceCharter({ understood: 42, assumptions: [7, null, { text: { a: 1 } }, { text: 'kept' }], wontTouch: [1, 'src/main/', ''], doneWhen: ['npm test'], ambiguity: 'vibes', question: 'which one?' }, 'r')
  assert.equal(c.understood, 'r')
  assert.deepEqual(c.assumptions, [{ text: 'kept', known: false }])
  assert.deepEqual(c.wontTouch, ['src/main/'])
  assert.equal(c.doneWhen, '')
  assert.equal(c.ambiguity, undefined)
  assert.equal(c.question, undefined)
})

test('a charter that shows its evidence reads as confident', () => {
  const c = coerceCharter({
    understood: 'Add a split subcommand',
    assumptions: [{ text: 'commands live in cli.ts', known: true, from: 'src/main/cli.ts' }],
    wontTouch: ['src/renderer/'],
    doneWhen: 'npm test',
    ambiguity: 'Scope'
  }, 'r', 1234)
  assert.deepEqual(c.assumptions, [{ text: 'commands live in cli.ts', known: true, from: 'src/main/cli.ts' }])
  assert.equal(c.ambiguity, 'scope')
  assert.equal(c.at, 1234)
  assert.ok(c.confidence >= FULL_CARD_BELOW)
})

test('the brief is one line, since a newline typed into a terminal submits it', () => {
  const b = charterBrief(coerceCharter({ understood: 'Add a split\n\nsubcommand', assumptions: [{ text: 'a\nb', known: false }], wontTouch: ['x'], doneWhen: 'npm test' }, 'r'))
  assert.doesNotMatch(b, /[\r\n]/)
})
