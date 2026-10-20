import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { opensSafely } from '../../src/main/fsops'

test('documents and folders open; programs and launchers are only revealed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-open-'))
  const f = (name: string, mode = 0o644) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, 'x', { mode })
    fs.chmodSync(p, mode)
    return p
  }
  assert.equal(opensSafely(dir), true)
  assert.equal(opensSafely(f('notes.md')), true)
  assert.equal(opensSafely(f('report.pdf')), true)
  assert.equal(opensSafely(f('evil.desktop')), false)
  assert.equal(opensSafely(f('setup.sh')), false)
  assert.equal(opensSafely(f('Tool.AppImage')), false)
  // (Windows has no executable bit: there it is the extension that decides)
  if (process.platform !== 'win32') assert.equal(opensSafely(f('no-extension-but-executable', 0o755)), false)
  else assert.equal(opensSafely(f('installer.scr')), false)
  assert.equal(opensSafely(path.join(dir, 'missing.md')), false)
})
