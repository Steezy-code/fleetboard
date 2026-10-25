// What a console keeps of its output to replay into its tile when it mounts again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ptybuf-'))
const { trimBuffer } = await import('../../src/main/pty')

test('the newest output is kept, cut where a line starts rather than inside an escape sequence', () => {
  const line = '\x1b[38;5;208mcolored output line\x1b[0m\r\n'
  const out = trimBuffer(line.repeat(1000), 10_000)
  assert.ok(out.length <= 10_000)
  assert.ok(out.startsWith('\x1b[38;5;208m'), 'starts on a whole line, its escape sequence intact')
  assert.ok(out.endsWith(line))
})

test('under the limit it is left alone, and with no line break near the cut it is cut there', () => {
  assert.equal(trimBuffer('short', 100), 'short')
  const solid = 'x'.repeat(50_000)
  assert.equal(trimBuffer(solid, 1000).length, 1000)
})
