// The path strings every ink shape is drawn from. Nothing covered this file before, and the loops in
// it were rewritten to walk neighbours (pairs/pairsRound/triplesRound/quads) rather than index by
// hand — so these pin the exact output for the deterministic paths, and the seeded ones for the
// hand-drawn passes, which are deterministic too: a shape must wobble the same way on every render.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { polygonPath, curveThrough, roughPolygon, roughPolyline, roughCurve, rng, hashStr } = await import('@/board/ink/rough')

type Pt = [number, number]
const rect: Pt[] = [
  [0, 0],
  [40, 0],
  [40, 20],
  [0, 20]
]
const curve: Pt[] = [
  [0, 0],
  [10, 10],
  [20, 0],
  [30, 10]
]

test('a square polygon, square corners and round ones', () => {
  assert.equal(polygonPath(rect, 0), 'M0 0L40 0L40 20L0 20Z')
  assert.equal(polygonPath(rect, 6), 'M6 0L34 0Q40 0 40 6L40 14Q40 20 34 20L6 20Q0 20 0 14L0 6Q0 0 6 0Z')
  // a radius larger than the shape is held to half the shortest side, not allowed to invert it
  assert.equal(polygonPath(rect, 1000), 'M10 0L30 0Q40 0 40 10L40 10Q40 20 30 20L10 20Q0 20 0 10L0 10Q0 0 10 0Z')
})

test('a polygon with no points is no path, where it used to throw', () => {
  // reading the first corner of no corners: the one reachable crash the flag pointed at here
  assert.equal(polygonPath([], 6), '')
  assert.equal(polygonPath([], 0), 'MZ')
  assert.equal(roughPolygon(rng(1), [], 6), '')
})

test('a curve through two points is the straight line between them', () => {
  assert.equal(curveThrough([[0, 0], [10, 5]]), 'M0 0L10 5')
})

test('a curve through four points bends through each of them', () => {
  assert.equal(curveThrough(curve), 'M0 0C1.67 1.67 6.67 10 10 10C13.33 10 16.67 0 20 0C23.33 0 28.33 8.33 30 10')
})

test('a curve needs two points, and says nothing about fewer', () => {
  assert.equal(curveThrough([]), '')
  assert.equal(curveThrough([[1, 1]]), '')
})

test('the hand-drawn passes are the same on every render for the same seed', () => {
  assert.equal(
    roughPolygon(rng(3), rect, 0, false),
    'M-1.7 1.05C13.69 -0.02 26.17 -0.91 40.21 -1.22M41.17 1.52C39.38 5.1 39.23 9.36 40.11 21.33M39.24 21.75C28.76 19.98 16.22 18.92 -0.53 20.89M1.45 20.41C0.92 17.14 0.53 12.32 -1.72 -0.51'
  )
  assert.equal(
    roughPolyline(rng(11), curve, false),
    'M0.26 0.99C3.14 1.81 6.14 6.33 9.86 9.94M10.51 9.04C12.79 5.65 17.1 2.24 20.23 -1.05M20.97 0.86C23.97 2.69 26.75 5.7 28.74 10.68'
  )
  // and a different seed is a different wobble, so the seeding is doing something
  assert.notEqual(roughPolyline(rng(12), curve, false), roughPolyline(rng(11), curve, false))
  assert.equal(hashStr('ink-1'), hashStr('ink-1'))
  assert.notEqual(hashStr('ink-1'), hashStr('ink-2'))
})

test('every closed shape is closed, and an open one is not', () => {
  assert.match(polygonPath(rect, 0), /Z$/)
  assert.match(polygonPath(rect, 6), /Z$/)
  assert.doesNotMatch(roughPolyline(rng(1), curve, false), /Z/)
  assert.doesNotMatch(roughCurve(rng(1), curve, false), /Z/)
})

test('a double-pass shape draws each edge twice', () => {
  const single = roughPolygon(rng(5), rect, 0, false)
  const double = roughPolygon(rng(5), rect, 0, true)
  assert.equal((single.match(/M/g) ?? []).length, 4, 'one pass per edge')
  assert.equal((double.match(/M/g) ?? []).length, 8, 'and twice that for two passes')
  assert.ok(!double.startsWith(single), 'the two passes are interleaved edge by edge, not appended')
})
