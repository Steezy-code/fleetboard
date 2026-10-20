// Oracle's brainstorm: which requests start one, and turning the panel's replies into ideas.
import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { brainstormTopic, coerceIdeas } = await import('@/voice/helm/brainstorm')

test('"brainstorm …" requests give their topic; other requests do not', () => {
  assert.equal(brainstormTopic('brainstorm onboarding for new users'), 'onboarding for new users')
  assert.equal(brainstormTopic("let's brainstorm about the pricing page?"), 'the pricing page')
  assert.equal(brainstormTopic('Brainstorm ideas for faster imports'), 'faster imports')
  assert.equal(brainstormTopic('brainstorm: offline mode'), 'offline mode')
  assert.equal(brainstormTopic('can we brainstorm ways to cut build time'), 'cut build time')
  assert.equal(brainstormTopic('brainstorm'), null)
  assert.equal(brainstormTopic('what did the brainstorm say'), null)
  assert.equal(brainstormTopic('spawn two agents'), null)
})

test("the panel's JSON becomes ideas: clipped, effort and impact checked, unknown panelists dropped", () => {
  const ideas = coerceIdeas(
    [
      { title: 'Stream big exports', pitch: 'Write rows as they are read.', why: 'Large tables time out today.', effort: 'small', impact: 4, from: ['pragmatist', 'Critic', 'someone'] },
      { title: 'No pitch here' },
      { title: 'Export to Sheets', description: 'One click to a Google Sheet.', effort: 'XL', impact: 9 }
    ],
    'wildcard'
  )
  assert.equal(ideas.length, 2)
  assert.deepEqual([ideas[0].effort, ideas[0].impact, ideas[0].from], ['S', 4, ['pragmatist', 'critic']])
  assert.equal(ideas[1].pitch, 'One click to a Google Sheet.')
  assert.equal(ideas[1].effort, undefined, 'XL is not an effort size')
  assert.equal(ideas[1].impact, undefined, 'impact is 1-5')
  assert.deepEqual(ideas[1].from, ['wildcard'], 'the panelist who sent it')
  assert.deepEqual(coerceIdeas({ ideas: [{ title: 'A', pitch: 'b' }] }).length, 1, 'an {ideas: [...]} wrapper works too')
})
