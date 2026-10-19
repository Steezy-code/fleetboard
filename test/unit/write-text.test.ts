// Saving a file the user edits: only over what the editor loaded, atomically, keeping permissions and links.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeText } from '../../src/main/fsops'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-write-'))

test('with a base: written while the file still holds it, refused (with what it holds) once an agent changed it', () => {
  const f = path.join(dir, 'a.ts')
  fs.writeFileSync(f, 'v1\n')
  assert.deepEqual(writeText(f, 'mine\n', 'v1\n'), { ok: true })
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine\n')
  fs.writeFileSync(f, 'agent\n') // an agent edits it meanwhile
  assert.deepEqual(writeText(f, 'mine again\n', 'mine\n'), { ok: false, reason: 'changed', current: 'agent\n' })
  assert.equal(fs.readFileSync(f, 'utf8'), 'agent\n', "the agent's change stays")
  fs.rmSync(f)
  assert.deepEqual(writeText(f, 'x', 'agent\n'), { ok: false, reason: 'changed', current: null }, 'deleted meanwhile')
  assert.deepEqual(writeText(f, 'x'), { ok: true }, 'without a base it just writes (a new file, or "replace with mine")')
})

test('permissions are kept, no temporary file is left behind, a symlink stays a symlink', () => {
  const script = path.join(dir, 'run.sh')
  fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 })
  writeText(script, '#!/bin/sh\necho hi\n')
  assert.equal(fs.statSync(script).mode & 0o777, 0o755)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [])
  const real = path.join(dir, 'real.conf')
  const link = path.join(dir, 'link.conf')
  fs.writeFileSync(real, 'a=1\n')
  fs.symlinkSync(real, link)
  assert.deepEqual(writeText(link, 'a=2\n', 'a=1\n'), { ok: true })
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(real, 'utf8'), 'a=2\n')
})

test('a new file in a new folder', () => {
  const f = path.join(dir, 'deep', 'er', 'new.md')
  assert.deepEqual(writeText(f, '# new\n'), { ok: true })
  assert.equal(fs.readFileSync(f, 'utf8'), '# new\n')
})
