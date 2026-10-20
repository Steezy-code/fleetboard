// Exporting a figure, on the items a board really holds — including a line or arrow whose points
// array is there but empty, which is what linePoints' own fallback exists for. That case threw out
// of the Excalidraw export (an empty array is truthy, so the guard above it let it through and the
// destructure of its first point failed), taking the whole export with it.
import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { figureToSvg, figureToExcalidraw, figureTitle, figureItems } = await import('@/studios/diagrams/export')

const item = (over: Record<string, unknown>) =>
  ({ id: Math.random().toString(36).slice(2), kind: 'rect', x: 0, y: 0, w: 60, h: 40, stroke: '#fff', width: 2, figureId: 'fig1', ...over }) as never

test('a line or arrow with an empty points array is left out, not fatal', () => {
  for (const kind of ['arrow', 'line']) {
    const items = [item({ kind, points: [] }), item({ kind: 'rect' })]
    const scene = figureToExcalidraw(items)
    assert.equal(scene.elements.length, 1, `${kind}: the rest of the figure still exports`)
    assert.equal(figureToSvg(items).svg.startsWith('<svg'), true, `${kind}: and it still draws`)
  }
})

test('a figure of nothing exports as nothing, rather than failing', () => {
  assert.deepEqual(figureToExcalidraw([]).elements, [])
  assert.equal(figureToSvg([]).svg.startsWith('<svg'), true)
})

test('every shape kind makes it into the SVG and the scene', () => {
  const items = [
    item({ kind: 'rect' }),
    item({ kind: 'ellipse' }),
    item({ kind: 'diamond' }),
    item({ kind: 'line', points: [[0, 0], [40, 20]] }),
    item({ kind: 'arrow', points: [[0, 0], [20, 30], [40, 10]] }),
    item({ kind: 'path', points: [[0, 0], [5, 9], [12, 3]] }),
    item({ kind: 'label', text: 'A label' })
  ]
  const { svg, width, height } = figureToSvg(items)
  assert.ok(width > 0 && height > 0, `${width}x${height}`)
  assert.equal((svg.match(/<(path|polygon|ellipse|rect|text)/g) ?? []).length >= items.length, true)
  assert.equal(figureToExcalidraw(items).elements.length, items.length)
})

test('a sloppy shape and a clean one both draw, and differ', () => {
  const clean = figureToSvg([item({ kind: 'rect', sloppy: false })]).svg
  const sloppy = figureToSvg([item({ kind: 'rect', sloppy: true })]).svg
  assert.notEqual(clean, sloppy)
  assert.match(clean, /<rect|<polygon|<path/)
  assert.match(sloppy, /<path/)
})

test('the figure title is its own text, and its items are the ones with its id', () => {
  const items = [item({ kind: 'label', text: 'Title here', role: 'title' }), item({ kind: 'rect', figureId: 'other' })]
  assert.equal(typeof figureTitle(items), 'string')
  assert.equal(figureItems(items, 'fig1').length, 1)
})
