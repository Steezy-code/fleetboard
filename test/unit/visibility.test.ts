import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offscreen } from '../../src/renderer/src/board/visibility'
test('offscreen paint decisions account for pan, zoom, tile extent and overscan', () => {
  const viewport = { w: 1000, h: 600 }
  const camera = { x: 0, y: 0, zoom: 1 }
  assert.equal(offscreen({ x: 1100, y: 0, w: 50, h: 50 }, camera, viewport), false)
  assert.equal(offscreen({ x: 1300, y: 0, w: 50, h: 50 }, camera, viewport), true)
  assert.equal(offscreen({ x: -1000, y: 0, w: 1100, h: 50 }, camera, viewport), false)
  assert.equal(offscreen({ x: 1300, y: 0, w: 50, h: 50 }, { x: -1000, y: 0, zoom: 1 }, viewport), false)
  assert.equal(offscreen({ x: 1300, y: 0, w: 50, h: 50 }, { x: 0, y: 0, zoom: 0.5 }, viewport), false)
})
