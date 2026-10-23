// Pausing a console on Windows: which processes get frozen, and in which order. There are no signals
// there, so the tree is walked by hand — and the order is the whole correctness of it. A parent
// suspended first cannot start a child that the walk would then miss; resuming has to go the other
// way, so nothing is left frozen under a parent that is already running again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { treeOf } from '../../src/main/suspend'

/** ppid → pid, as Win32_Process reports them (unordered, and with the rest of the machine in it). */
const rows = [
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 100 },
  { pid: 400, ppid: 200 },
  { pid: 500, ppid: 1 },
  { pid: 600, ppid: 500 }
]

test('the tree is the root and everything under it, parents before children', () => {
  assert.deepEqual(treeOf(rows, 100), [100, 200, 300, 400])
})

test('nothing outside the tree is touched', () => {
  assert.ok(!treeOf(rows, 100).includes(500), 'a sibling tree')
  assert.ok(!treeOf(rows, 100).includes(600), "a sibling's child")
  assert.ok(!treeOf(rows, 100).includes(1), 'the parent of the root')
})

test('a leaf is just itself, and an unknown pid is still itself', () => {
  assert.deepEqual(treeOf(rows, 400), [400])
  assert.deepEqual(treeOf(rows, 999), [999], 'a process that ended between the walk and now')
})

test('a cycle in what the system reported cannot hang the walk', () => {
  const bad = [
    { pid: 10, ppid: 11 },
    { pid: 11, ppid: 10 }
  ]
  assert.deepEqual(treeOf(bad, 10), [10, 11])
})

test('a pid that is its own parent cannot hang the walk', () => {
  assert.deepEqual(treeOf([{ pid: 7, ppid: 7 }], 7), [7])
})

test('pid 0 is never in a tree: it is not a process anything may be suspended through', () => {
  assert.deepEqual(
    treeOf(
      [
        { pid: 0, ppid: 0 },
        { pid: 5, ppid: 0 }
      ],
      0
    ),
    []
  )
  assert.deepEqual(treeOf(rows, 0), [])
})
