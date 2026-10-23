// Oracle may run one of its own options without asking. autoSafe is the whole of what decides that,
// and coerceResult is what turns a model's reply into the card — including the index of the option it
// would like run on its own. Nothing tested either, while a widened autoSafe is an action taken on
// the user's behalf with no click, and the model picks the index.
import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { autoSafe, coerceResult } = await import('@/voice/helm/helm')

const option = (o: Partial<Parameters<typeof autoSafe>[0]>) => ({ label: 'l', detail: 'd', kind: 'panel', ...o }) as Parameters<typeof autoSafe>[0]

test('opening a panel is safe on its own; anything that spawns, types or runs is not', () => {
  assert.equal(autoSafe(option({ kind: 'panel', panel: 'loops' })), true, 'a panel only shows something')
  for (const kind of ['team', 'actions', 'github', 'brainstorm', 'answer'] as const) {
    assert.equal(autoSafe(option({ kind })), false, kind)
  }
})

test('a message may be typed for you only if it is left unsent, and into few enough consoles', () => {
  // typed but not submitted: the user still presses Enter, so it is a draft and not an instruction
  assert.equal(autoSafe(option({ kind: 'send', submit: false, targets: [] })), true)
  assert.equal(autoSafe(option({ kind: 'send', submit: true, targets: [] })), false, 'submitting is never automatic')
  assert.equal(autoSafe(option({ kind: 'send', targets: [] })), false, 'and neither is leaving it unsaid')
})

test('only the read-only playbooks run themselves, and only with every input filled', () => {
  assert.equal(autoSafe(option({ kind: 'playbook', playbook: { id: 'morning-sweep', inputs: {} } })), true)
  assert.equal(autoSafe(option({ kind: 'playbook', playbook: { id: 'pr-review', inputs: {} } })), true)
  assert.equal(autoSafe(option({ kind: 'playbook', playbook: { id: 'db-safety', inputs: {} } })), true)
  // anything not on that list — including one that does not exist — waits for a click
  assert.equal(autoSafe(option({ kind: 'playbook', playbook: { id: 'ship-it', inputs: {} } })), false)
  assert.equal(autoSafe(option({ kind: 'playbook', playbook: { id: '', inputs: {} } })), false)
})

test('the model cannot name an option to auto-run that is unsafe, or that is not there', () => {
  const card = (auto: unknown, kind = 'team') =>
    coerceResult({ reply: 'here', auto, options: [{ label: 'a', detail: 'd', kind, panel: 'loops' }] })
  assert.equal(card(0).auto, null, 'a team is not safe, so its index is refused')
  assert.equal(card(0, 'panel').auto, 0, 'a panel is')
  assert.equal(card(5, 'panel').auto, null, 'an index past the end')
  assert.equal(card(-1, 'panel').auto, null, 'a negative one')
  assert.equal(card(0.5, 'panel').auto, null, 'a fractional one')
  assert.equal(card('0', 'panel').auto, null, 'a string')
  assert.equal(card(null, 'panel').auto, null)
})
