// "Today" is the user's own calendar day. The UTC day (toISOString) is a different one for hours at a
// time west of UTC, and a calendar filtered by it drops the evening's own events.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayKey } from '../../src/shared/time'
import { ymd } from '../../src/renderer/src/nodes/content/util'

test('dayKey is the local calendar day, late in the evening included', () => {
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 30).getTime()), '2026-01-02')
  assert.equal(dayKey(new Date(2026, 0, 2, 0, 5).getTime()), '2026-01-02')
  assert.equal(dayKey(new Date(2026, 11, 31, 12).getTime()), '2026-12-31')
})

test('the calendar tile and the journal name the same day for the same instant', () => {
  const d = new Date(2026, 6, 9, 22, 45)
  assert.equal(ymd(d), dayKey(d.getTime()))
})
