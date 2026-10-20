// Where a label sits on a line, and what happens on the degenerate lines a board really holds: a
// line dragged to a single point, a line whose ends coincide, a polyline of two identical points.
// midPoint used to accept a polyline with no points at all and return undefined typed as a point,
// which the callers then read coordinates off; it now says it needs one, and this pins what it
// answers for the smallest ones it does accept.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { midPoint, linePoints } = await import('@/board/ink/geometry')

const item = (over: Record<string, unknown> = {}) => ({ id: 'i1', kind: 'line', x: 10, y: 20, w: 100, h: 0, ...over }) as never

test('halfway along a straight line is its middle', () => {
  assert.deepEqual(midPoint([[0, 0], [10, 0]]), [5, 0])
  assert.deepEqual(midPoint([[0, 0], [0, 10]]), [0, 5])
})

test('a single point is its own midpoint', () => {
  assert.deepEqual(midPoint([[7, 9]]), [7, 9])
})

test('a line of zero length answers a real point rather than NaN', () => {
  const [x, y] = midPoint([[4, 4], [4, 4]])
  assert.equal(Number.isFinite(x) && Number.isFinite(y), true, `${x},${y}`)
  assert.deepEqual([x, y], [4, 4])
})

test('halfway along a bent polyline is measured along it, not between its ends', () => {
  // an L: 10 across then 10 down, so the middle is the corner
  assert.deepEqual(midPoint([[0, 0], [10, 0], [10, 10]]), [10, 0])
  // and the longer first leg puts it on that leg
  assert.deepEqual(midPoint([[0, 0], [20, 0], [20, 4]]), [12, 0])
})

test('a line without its own points still has the two corners of its box', () => {
  assert.deepEqual(linePoints(item()), [[10, 20], [110, 20]])
  assert.deepEqual(linePoints(item({ points: [[1, 2], [3, 4], [5, 6]] })), [[1, 2], [3, 4], [5, 6]])
  // the empty case is the one that used to produce a point out of nothing
  assert.deepEqual(linePoints(item({ points: [] })), [[10, 20], [110, 20]])
})
