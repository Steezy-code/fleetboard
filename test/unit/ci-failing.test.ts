// Which CI conclusions are red: one list, read by the sweep's ranking and its panel alike, so a
// repo cannot be red in one and not the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFailing } from '../../src/shared/ci'

test('failures, time-outs and runs that never started are failing, in any case', () => {
  for (const c of ['failure', 'FAILURE', 'timed_out', 'startup_failure', 'action_required']) assert.equal(isFailing(c), true, c)
})

test('cancelled, skipped, passing and still-running runs are not', () => {
  for (const c of ['cancelled', 'skipped', 'success', 'neutral', '', null, undefined]) assert.equal(isFailing(c), false, String(c))
})
