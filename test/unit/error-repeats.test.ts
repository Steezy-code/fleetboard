// The renderer's stray errors go to the main log. One thrown on every frame used to fill the 1 MB log
// in seconds and rotate out the first error, which is the one that says what went wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-errors-'))
process.env.FLEETBOARD_HOME = home
const { logRepeated } = await import('../../src/main/errors')
const log = () => fs.readFileSync(path.join(home, 'logs', 'main.log'), 'utf8')

test('the same error a hundred times in a minute is a few lines and a count', () => {
  const t = 1_000_000
  for (let i = 0; i < 100; i++) logRepeated('renderer', 'TypeError: x is undefined\n    at frame', t + i)
  assert.equal(log().split('\n').filter((l) => l.includes('TypeError: x is undefined')).length, 5)
  assert.equal(logRepeated('renderer', 'RangeError: another one', t + 200), true, 'a different error still gets through')
  logRepeated('renderer', 'TypeError: x is undefined', t + 61_000)
  assert.match(log(), /repeated 95 more times in a minute/)
})
