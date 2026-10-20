// Edge labels in the diagram studio. polylineMid used to take a polyline with no points and hand
// back undefined as the label position, which the renderer reads x and y off; it now asks for a
// polyline with points, and these pin that every edge of a laid-out diagram gets a real position —
// including the shapes that come out of a spec an agent wrote: one node, two, and a cycle.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { layoutDiagram } = await import('@/studios/diagrams/layout')
const { sanitizeSpec } = await import('@/studios/diagrams/spec')

const spec = (nodes: string[], edges: [string, string][], layout?: string) =>
  sanitizeSpec({
    title: 'T',
    layout,
    nodes: nodes.map((id) => ({ id, label: id.toUpperCase(), shape: 'rect' })),
    edges: edges.map(([from, to]) => ({ from, to, label: `${from}→${to}` }))
  })!

const finite = (p: unknown): boolean => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))

for (const layout of ['TB', 'LR', 'radial']) {
  test(`every edge of a ${layout} diagram has a label position that is a real point`, () => {
    const l = layoutDiagram(spec(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['a', 'd'], ['d', 'c']], layout))
    assert.equal(l.edges.length, 4)
    for (const e of l.edges) {
      assert.ok(finite(e.labelAt), `${e.from}→${e.to}: ${JSON.stringify(e.labelAt)}`)
      assert.ok(e.points.length >= 2, `${e.from}→${e.to} has a polyline`)
    }
  })
}

test('a diagram of one node and no edges lays out without inventing an edge', () => {
  const l = layoutDiagram(spec(['only'], []))
  assert.deepEqual(l.edges, [])
  assert.equal(l.nodes.length, 1)
})

test('a cycle still gives every edge a label position', () => {
  const l = layoutDiagram(spec(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]))
  assert.equal(l.edges.length, 3)
  for (const e of l.edges) assert.ok(finite(e.labelAt), `${e.from}→${e.to}`)
})

test('an edge from a node to itself is dropped before layout, so no chain is one point long', () => {
  const s = spec(['a', 'b'], [['a', 'a'], ['a', 'b']])
  assert.deepEqual(
    s.edges.map((e) => [e.from, e.to]),
    [['a', 'b']]
  )
})
