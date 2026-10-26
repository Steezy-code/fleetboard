import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilitiesOf } from '../../src/shared/capabilities'
test('terminal-only catalog entries do not claim validated orchestration', () => {
  for (const id of ['aider', 'opencode', 'custom-local']) {
    const c = capabilitiesOf(id)
    assert.equal(c.tier, 'Terminal only')
    assert.equal(c.teams, false); assert.equal(c.prompts, false); assert.equal(c.resume, false); assert.equal(c.usage, false)
  }
  assert.equal(capabilitiesOf('claude').teams, true)
  assert.equal(capabilitiesOf('codex').readOnlyPlanner, true)
  assert.equal(capabilitiesOf('gemini').resume, true)
  assert.equal(capabilitiesOf('shell').tier, 'Shell')
  for (const id of ['antigravity', 'freebuff']) {
    assert.equal(capabilitiesOf(id).teams, true)
    assert.equal(capabilitiesOf(id).usage, false)
    assert.equal(capabilitiesOf(id).resume, false)
  }
  assert.equal(capabilitiesOf('antigravity').readOnlyPlanner, true)
  assert.equal(capabilitiesOf('freebuff').readOnlyPlanner, false)
})
