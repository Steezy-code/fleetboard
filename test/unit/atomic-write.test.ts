// ~/.fleetboard holds the only copy of a board. Rename makes a write atomic for the *name*, so a
// half-written file is never seen under the real one — but on its own it says nothing about when the
// contents reach the disk, and a failed write must not leave its temporary file behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-atomic-'))
process.env.FLEETBOARD_HOME = home
const { writeJsonAtomic, readJson } = await import('../../src/main/paths')

const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

test('a write lands whole, and leaves no temporary file behind', () => {
  const file = path.join(home, 'board.json')
  writeJsonAtomic(file, { a: 1, nested: { b: [1, 2, 3] } })
  assert.deepEqual(readJson(file, null), { a: 1, nested: { b: [1, 2, 3] } })
  assert.deepEqual(leftovers(home), [], 'no .tmp left over')
  // and again, over an existing file
  writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(readJson(file, null), { a: 2 })
  assert.deepEqual(leftovers(home), [])
})

test('a mode is honoured, so a file with a token in it is not world-readable', () => {
  const file = path.join(home, 'secret.json')
  writeJsonAtomic(file, { token: 'x' }, 0o600)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(leftovers(home), [])
})

test('pretty by default, compact when asked (the usage cache is rewritten whole on every scan)', () => {
  const a = path.join(home, 'pretty.json')
  const b = path.join(home, 'compact.json')
  const value = { files: { x: [[1, 2, 3, 4, 5, 6, 7, 8]] } }
  writeJsonAtomic(a, value)
  writeJsonAtomic(b, value, undefined, { pretty: false })
  assert.match(fs.readFileSync(a, 'utf8'), /\n/, 'readable by hand')
  assert.doesNotMatch(fs.readFileSync(b, 'utf8'), /\n/, 'one line')
  assert.ok(fs.readFileSync(b, 'utf8').length < fs.readFileSync(a, 'utf8').length / 2, 'and much smaller')
  assert.deepEqual(readJson(b, null), value, 'still the same data')
})

test('a write that cannot succeed throws, keeps the old file, and cleans up after itself', () => {
  const dir = path.join(home, 'sub')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'state.json')
  writeJsonAtomic(file, { good: true })

  // a value JSON cannot represent: the write fails before anything is renamed
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.throws(() => writeJsonAtomic(file, circular))
  assert.deepEqual(readJson(file, null), { good: true }, 'the old contents survive')
  assert.deepEqual(leftovers(dir), [], 'and no .tmp is left in the folder')

  // a path that cannot be opened at all (a directory where the file should be)
  const asDir = path.join(dir, 'nope.json')
  fs.mkdirSync(asDir)
  assert.throws(() => writeJsonAtomic(asDir, { x: 1 }))
  assert.deepEqual(leftovers(dir), [])
})
