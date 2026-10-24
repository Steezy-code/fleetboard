import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verificationOf } from '../../src/shared/mergeReview'
import type { FleetReady } from '../../src/shared/fleet'

const ready: FleetReady = { leadId: 'l', branch: 'b', summary: 'done', commits: 1, files: [], at: 1, head: 'abc', verified: 'all tests pass' }
test('agent prose is never observed verification', () => assert.equal(verificationOf(ready), 'unobserved'))
test('only a stable successful check of the offered commit passes', () => {
  const evidence = { command: 'npm test', run: { at: 2, code: 0, head: 'abc', stable: true } }
  assert.equal(verificationOf({ ...ready, evidence }), 'passed')
  for (const run of [{ ...evidence.run, stable: false }, { ...evidence.run, stable: undefined }, { ...evidence.run, head: 'old' }]) assert.equal(verificationOf({ ...ready, evidence: { ...evidence, run } }), 'stale')
  for (const run of [{ ...evidence.run, code: 1 }, { ...evidence.run, code: null }, { ...evidence.run, timedOut: true }, { ...evidence.run, failing: 2 }, { ...evidence.run, error: 'stopped' }]) assert.equal(verificationOf({ ...ready, evidence: { ...evidence, run } }), 'failed')
})
