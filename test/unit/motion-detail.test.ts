// The two decisions behind the second round of board motion that are pure enough to pin down here:
// when cards drop to compact labels (which must not flicker) and what counts as an inbox arrival
// (which must not fire on a refresh). The effects themselves are end-to-end ground (test/e2e/motion.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZOOM_COMPACT_IN, ZOOM_COMPACT_OUT, arrivedKeys, compactAtZoom, effectiveMotion, eventDuration } from '../../src/shared/motion'

test('compact labels have hysteresis, so hovering on the threshold does not flicker', () => {
  assert.equal(compactAtZoom(1, false), false)
  assert.equal(compactAtZoom(0.49, false), true, 'crossing in')
  assert.equal(compactAtZoom(0.55, true), true, 'inside the gap it stays compact')
  assert.equal(compactAtZoom(0.55, false), false, 'inside the gap it stays detailed')
  assert.equal(compactAtZoom(0.63, true), false, 'crossing back out')
  assert.ok(ZOOM_COMPACT_IN < ZOOM_COMPACT_OUT, 'the gap exists at all')

  // A trackpad drifting over the threshold: one crossing, not one per frame.
  let compact = false
  let flips = 0
  for (const zoom of [0.52, 0.5, 0.48, 0.5, 0.53, 0.55, 0.58, 0.55, 0.52, 0.5]) {
    const next = compactAtZoom(zoom, compact)
    if (next !== compact) flips++
    compact = next
  }
  assert.equal(flips, 1, 'drifting across the threshold flips the layout once')
})

test('an inbox arrival is a new key, not a rebuilt list', () => {
  assert.deepEqual(arrivedKeys(['a', 'b'], ['a', 'b']), [], 'a refresh of the same items is not an arrival')
  assert.deepEqual(arrivedKeys(['a', 'b'], ['b', 'a']), [], 'reordering (a cycle) is not an arrival')
  assert.deepEqual(arrivedKeys(['a'], ['a', 'b']), ['b'])
  assert.deepEqual(arrivedKeys([], ['a', 'b']), ['a', 'b'], 'the first pass is the caller to suppress, not this')
  assert.deepEqual(arrivedKeys(['a', 'b'], ['b']), [], 'an item answered and gone is not an arrival')
})

test('off has no event motion at all, and the system preference wins', () => {
  assert.equal(eventDuration('off'), 0)
  assert.ok(eventDuration('subtle') > 0 && eventDuration('full') > eventDuration('subtle'))
  assert.equal(effectiveMotion('full', true), 'off', 'reduced motion overrides the saved choice')
})
