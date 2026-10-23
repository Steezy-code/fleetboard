// The charter: what a goal was understood to be, and the score that says how far to trust that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FULL_CARD_BELOW, charterBrief, charterMessage, coerceCharter, scoreConfidence } from '../../src/shared/charter'

test('confidence is the share of assumptions that cite evidence', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }, { text: 'c', known: false }], wontTouch: ['x'], doneWhen: 'npm test' }
  assert.equal(scoreConfidence(c), 67)
})

test('no done-when caps confidence, however many assumptions are known', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }], wontTouch: ['x'], doneWhen: '' }
  assert.equal(scoreConfidence(c), 60)
})

test('a won\'t-touch written as a description counts as none: the merge gate cannot enforce it', () => {
  const c = (wontTouch: string[]) => ({ assumptions: [{ text: 'a', known: true }], wontTouch, doneWhen: 'npm test' })
  assert.equal(scoreConfidence(c(['src/auth'])), 100)
  assert.equal(scoreConfidence(c(['the auth module'])), 90)
  assert.equal(scoreConfidence(c([])), 90)
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

// The charter says what the job is and how it is known to be done. A goal that is more than the request
// the user typed (a playbook's step list, Oracle's rewrite) says how to go about it, so it follows the brief.
const MSG = coerceCharter({ understood: 'Add a split subcommand', doneWhen: 'npm test' }, 'add split to the cli', 1)

test('a goal that is the request adds nothing to the brief', () => {
  assert.equal(charterMessage(MSG, 'add split to the cli'), charterBrief(MSG))
  assert.equal(charterMessage(MSG, '  add split\n to the   cli \n'), charterBrief(MSG), 'spacing is not a different goal')
})

test('a goal that is more than the request follows the brief, whole', () => {
  const how = 'Find the split subcommand in src/cli and write one file per page range.'
  assert.equal(charterMessage(MSG, how), charterBrief(MSG) + ' ' + how)
})

test('what follows the brief is one line too, since a newline typed into a terminal submits it', () => {
  const m = charterMessage(MSG, 'Playbook "Hotfix".\n1) reproduce it\n\n2) fix it  ')
  assert.doesNotMatch(m, /[\r\n]/)
  assert.ok(m.endsWith('Playbook "Hotfix". 1) reproduce it 2) fix it'))
})

test('an empty goal adds nothing', () => {
  assert.equal(charterMessage(MSG, '  \n'), charterBrief(MSG))
})

test('a multi-line request is still the request: the goal that is the same text is not added again', () => {
  const pasted = 'add split to the cli\n\nwith tests'
  const c = coerceCharter({ understood: 'Add split with tests' }, pasted, 1)
  assert.equal(charterMessage(c, pasted), charterBrief(c))
})
