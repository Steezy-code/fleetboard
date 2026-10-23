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

test('on Windows only what opens in a viewer is opened: the shell runs more types than any list of them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-open-win-'))
  const f = (name: string) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, 'x')
    return p
  }
  for (const doc of ['notes.md', 'report.pdf', 'shot.png', 'data.csv', 'sheet.xlsx']) assert.equal(opensSafely(f(doc), 'win32'), true, doc)
  // .js and .jse run under Windows Script Host; the rest are launchers or containers that run code
  for (const run of ['setup.js', 'a.jse', 'a.vbe', 'a.wsc', 'a.pif', 'help.chm', 'x.settingcontent-ms', 'page.html', 'pic.svg', 'unknown.zzz']) {
    assert.equal(opensSafely(f(run), 'win32'), false, run)
  }
  // elsewhere a script is not opened either, executable bit or not
  assert.equal(opensSafely(f('tool.js'), 'linux'), false)
  assert.equal(opensSafely(f('notes.txt'), 'linux'), true)
})

test('a folder macOS would run, an app bundle or an installer, is revealed rather than opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bundle-'))
  for (const name of ['Evil.app', 'Thing.prefPane', 'Do.workflow', 'Setup.pkg']) {
    fs.mkdirSync(path.join(root, name))
    assert.equal(opensSafely(path.join(root, name)), false, name)
  }
  fs.mkdirSync(path.join(root, 'docs'))
  assert.equal(opensSafely(path.join(root, 'docs')), true, 'a plain folder still opens')
})
