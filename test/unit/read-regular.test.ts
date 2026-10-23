// Repo content is untrusted, and the main process carries every console's output: a read that blocks
// or eats memory there freezes the whole app. A FIFO named package.json, or a link to /dev/zero,
// must be refused before reading, not discovered by reading.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRegularText } from '../../src/main/paths'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fb-read-'))

test('a regular file is read; a folder or a file over the limit is refused', () => {
  const d = dir()
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello')
  assert.equal(readRegularText(path.join(d, 'a.txt'), 100), 'hello')
  assert.throws(() => readRegularText(d, 100), /Not a regular file/)
  fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(200))
  assert.throws(() => readRegularText(path.join(d, 'big.txt'), 100), /Too large/)
})

test('a FIFO and a device are refused without blocking', { skip: process.platform === 'win32' }, () => {
  const d = dir()
  const fifo = path.join(d, 'package.json')
  execFileSync('mkfifo', [fifo])
  const started = Date.now()
  assert.throws(() => readRegularText(fifo, 1024), /Not a regular file/)
  assert.ok(Date.now() - started < 1000, 'returned at once')
  fs.symlinkSync('/dev/zero', path.join(d, 'zero.md'))
  assert.throws(() => readRegularText(path.join(d, 'zero.md'), 1024), /Not a regular file/)
})
