// Where new tiles go and what Tidy does. The ways this goes wrong are quiet ones: a tile landing on
// top of a console you were reading, a folded group's hidden consoles still taking room, Tidy
// splitting a Lead from its workers, or a second Tidy rearranging what the first one just laid out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFreeSpot, groupBox, hiddenIds, occupied, tidyLayout, tidyUnits, contentOrigin, GROUP_HEAD_H, type Box } from '../../src/renderer/src/board/place'
import type { BoardNode, Group, InkItem, Wire } from '../../src/shared/types'

const node = (id: string, x: number, y: number, w = 100, h = 100, over: Partial<BoardNode> = {}): BoardNode => ({ id, type: 'console', x, y, w, h, z: 1, data: {}, ...over })
const group = (id: string, x: number, y: number, w: number, h: number, collapsed = false): Group => ({ id, name: id, role: 'General', x, y, w, h, collapsed })
const ink = (id: string, x: number, y: number, figureId?: string): InkItem => ({ id, kind: 'rect', x, y, w: 50, h: 50, ...(figureId ? { figureId } : {}) }) as InkItem
const clear = (spot: { x: number; y: number }, size: { w: number; h: number }, boxes: Box[], gap: number) =>
  boxes.every((b) => spot.x >= b.x + b.w + gap || b.x >= spot.x + size.w + gap || spot.y >= b.y + b.h + gap || b.y >= spot.y + size.h + gap)

// ---------------------------------------------------------------- findFreeSpot

test('findFreeSpot: where it was asked for, when that is free', () => {
  assert.deepEqual(findFreeSpot([node('a', 0, 0)], { w: 100, h: 100 }, { x: 500, y: 0 }), { x: 500, y: 0 })
  assert.deepEqual(findFreeSpot([], { w: 100, h: 100 }, { x: 12.4, y: -3.6 }), { x: 12, y: -4 })
})

test('findFreeSpot: otherwise the nearest spot that covers nothing and keeps the gap', () => {
  const boxes = [node('a', 0, 0, 400, 300)]
  const spot = findFreeSpot(boxes, { w: 200, h: 200 }, { x: 100, y: 50 }, 40)
  assert.ok(clear(spot, { w: 200, h: 200 }, boxes, 40), JSON.stringify(spot))
  // the nearest of right (x 440) and below (y 340) of the box: right is 340 away, below 290
  assert.deepEqual(spot, { x: 100, y: 340 })
})

test('findFreeSpot: on a crowded board it still never overlaps, and lines up with what is there', () => {
  const boxes: Box[] = []
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) boxes.push({ x: c * 300, y: r * 250, w: 260, h: 210 })
  const size = { w: 260, h: 210 }
  const spot = findFreeSpot(boxes, size, { x: 400, y: 300 }, 40)
  assert.ok(clear(spot, size, boxes, 40), JSON.stringify(spot))
  assert.ok(boxes.some((b) => b.x === spot.x || b.y === spot.y), 'aligned to an existing row or column')
})

// ---------------------------------------------------------------- folded groups

test('a folded group takes only its header, and its members take no room at all', () => {
  const ws = { nodes: [node('m1', 20, 60, 300, 300, { groupId: 'g' }), node('free', 2000, 0)], groups: [group('g', 0, 0, 400, 500, true)], ink: [] }
  assert.deepEqual([...hiddenIds(ws)], ['m1'])
  assert.deepEqual(groupBox(ws.groups[0]!), { x: 0, y: 0, w: 400, h: GROUP_HEAD_H })
  const boxes = occupied(ws)
  assert.equal(boxes.length, 2, 'the hidden member is not there')
  // so a new tile can go where the folded group's body used to be
  assert.deepEqual(findFreeSpot(boxes, { w: 300, h: 200 }, { x: 0, y: 120 }, 40), { x: 0, y: 120 })
})

// ---------------------------------------------------------------- tidy

const wire = (from: string, to: string): Wire => ({ id: `${from}-${to}`, from, to })

test('tidyUnits: a group with its members, a Lead with its workers and plan, a diagram, each as one', () => {
  const ws = {
    nodes: [
      node('lead', 0, 0),
      node('w1', 0, 200),
      node('w2', 150, 200),
      node('plan', -200, 0, 100, 100, { type: 'plan', data: { leadId: 'lead' } }),
      node('m', 1000, 60, 100, 100, { groupId: 'g' }),
      node('note', 3000, 0, 100, 100, { type: 'note' })
    ],
    groups: [group('g', 980, 0, 200, 200)],
    wires: [wire('lead', 'w1'), wire('lead', 'w2')],
    ink: [ink('f1', 5000, 0, 'fig'), ink('f2', 5100, 0, 'fig'), ink('scribble', 0, 0)]
  }
  const units = tidyUnits(ws).map((u) => [...u.ids].sort().join(','))
  assert.deepEqual(units.sort(), ['f1,f2', 'g,m', 'lead,plan,w1,w2', 'note'].sort(), 'loose ink is not a unit: it stays with what it was drawn on')
})

test('tidyUnits: a folded group is as big as its header, though its members move with it', () => {
  const ws = { nodes: [node('m', 20, 60, 600, 600, { groupId: 'g' })], groups: [group('g', 0, 0, 700, 700, true)], wires: [], ink: [] }
  const [u] = tidyUnits(ws)
  assert.deepEqual(u!.ids.sort(), ['g', 'm'])
  assert.deepEqual(u!.box, { x: 0, y: 0, w: 700, h: GROUP_HEAD_H })
})

test('tidyLayout: consoles first, rows that fit, nothing overlapping, and tidy twice changes nothing', () => {
  const ws = {
    nodes: [node('note', 900, 900, 200, 200, { type: 'note' }), node('c1', 3000, 50, 400, 300), node('c2', -800, 2000, 400, 300), node('web', 10, 10, 600, 400, { type: 'web' })],
    groups: [],
    wires: [],
    ink: []
  }
  const units = tidyUnits(ws)
  const origin = contentOrigin(units)
  const moves = tidyLayout(units, origin)
  const moved = ws.nodes.map((n) => {
    const m = moves.find((x) => x.ids.includes(n.id))
    return { ...n, x: n.x + (m?.dx ?? 0), y: n.y + (m?.dy ?? 0) }
  })
  const at = Object.fromEntries(moved.map((n) => [n.id, n]))
  assert.deepEqual([at.c1!.y, at.c2!.y], [origin.y, origin.y], 'the consoles lead the first row')
  assert.ok(at.web!.y > origin.y && at.note!.y > origin.y, 'the other tiles come after, in the next row')
  for (const a of moved) for (const b of moved) if (a !== b) assert.ok(clear(a, a, [b], 0), `${a.id} overlaps ${b.id}`)
  const again = tidyLayout(tidyUnits({ ...ws, nodes: moved }), contentOrigin(tidyUnits({ ...ws, nodes: moved })))
  assert.deepEqual(again, [], 'a tidy board stays as it is')
})
