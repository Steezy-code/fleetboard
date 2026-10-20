// The neighbour walkers every geometry loop now uses instead of indexing. What they do at the ends
// of a list, and on lists too short to have a window at all, is the whole of their contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pairs, pairsRound, triplesRound, quads } = await import('@shared/seq')

test('pairs walks consecutive pairs and stops at the end', () => {
  assert.deepEqual([...pairs([1, 2, 3, 4])], [[1, 2], [2, 3], [3, 4]])
  assert.deepEqual([...pairs([1, 2])], [[1, 2]])
  assert.deepEqual([...pairs([1])], [])
  assert.deepEqual([...pairs([])], [])
})

test('pairsRound closes back to the first item', () => {
  assert.deepEqual([...pairsRound([1, 2, 3])], [[1, 2], [2, 3], [3, 1]])
  assert.deepEqual([...pairsRound([1])], [[1, 1]], 'one item is its own neighbour')
  assert.deepEqual([...pairsRound([])], [])
})

test('triplesRound gives every item its two neighbours, wrapping', () => {
  assert.deepEqual([...triplesRound([1, 2, 3, 4])], [
    [4, 1, 2],
    [1, 2, 3],
    [2, 3, 4],
    [3, 4, 1]
  ])
  assert.deepEqual([...triplesRound([1, 2])], [
    [2, 1, 2],
    [1, 2, 1]
  ])
  assert.deepEqual([...triplesRound([])], [])
})

test('quads walks windows of four', () => {
  assert.deepEqual([...quads([1, 2, 3, 4, 5])], [
    [1, 2, 3, 4],
    [2, 3, 4, 5]
  ])
  assert.deepEqual([...quads([1, 2, 3])], [])
})

test('an undefined item is skipped rather than yielded as a value', () => {
  // the walkers promise values; a list holding holes is not one they describe
  assert.deepEqual([...pairs([1, undefined, 3])], [])
  assert.deepEqual([...quads([1, 2, undefined, 4, 5])], [])
})
