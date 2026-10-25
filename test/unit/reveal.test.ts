import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardIsRevealed, markBoardRevealed, waveKey } from '../../src/renderer/src/lib/reveal'

test('the wave runs before any board is open, and again for each board', () => {
  // a cold launch opens no project: Home must still get a key, or the wave never runs at all
  assert.notEqual(waveKey(undefined), waveKey('ws-1'))
  assert.equal(waveKey('ws-1'), 'ws-1')

  // Home's wave is not a board's wave: a tile on ws-1 must not take it for its own
  markBoardRevealed(waveKey(undefined))
  assert.equal(boardIsRevealed('ws-1'), false)

  markBoardRevealed('ws-1')
  assert.equal(boardIsRevealed('ws-1'), true)
  // and switching boards leaves the new one un-waved until it has its own
  assert.equal(boardIsRevealed('ws-2'), false)
  assert.equal(boardIsRevealed(undefined), false)
})
