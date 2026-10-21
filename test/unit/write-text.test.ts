// Saving a file the user edits: only over what the editor loaded, atomically, keeping permissions and links.
import { test, mock } from 'node:test'
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

test('the contents reach the disk, not just the directory entry', () => {
  // A rename is atomic for the *name*, so a half-written file is never seen under the real one — but
  // the bytes can still be in the page cache when the power goes, and the file comes back empty. The
  // board file has snapshots to fall back on; a source file saved from Code studio has nothing.
  //
  // syncDir fsyncs the directory too, and the kernel hands the directory the descriptor number the
  // closed temporary file just gave up — so only an fsync while that file is still open counts.
  const f = path.join(dir, 'durable.ts')
  const real = { open: fs.openSync, fsync: fs.fsyncSync, close: fs.closeSync }
  let tmpFd: number | null = null
  let fsyncedTmp = false
  const open = mock.method(fs, 'openSync', ((file: any, ...rest: any[]) => {
    const fd = (real.open as any)(file, ...rest)
    if (typeof file === 'string' && file.includes('.fleetboard-')) tmpFd = fd
    return fd
  }) as any)
  const fsync = mock.method(fs, 'fsyncSync', ((fd: number) => {
    if (fd === tmpFd) fsyncedTmp = true
    return real.fsync(fd)
  }) as any)
  const close = mock.method(fs, 'closeSync', ((fd: number) => {
    if (fd === tmpFd) tmpFd = null
    return real.close(fd)
  }) as any)
  try {
    assert.deepEqual(writeText(f, 'export const x = 1\n'), { ok: true })
    assert.ok(fsyncedTmp, 'the file itself is fsynced before it is renamed into place')
  } finally {
    close.mock.restore()
    fsync.mock.restore()
    open.mock.restore()
  }
  assert.equal(fs.readFileSync(f, 'utf8'), 'export const x = 1\n')
})

test('a PNG export is written the same careful way, through a symlink and without truncating', async () => {
  // fs:writeBase64 (diagram export) used to be a bare writeFileSync: it truncated the target in place,
  // so a write that ran out of room destroyed what was there, and it turned a symlink into a plain
  // file — the one thing writeText goes out of its way not to do.
  const { ipcMain } = await import('../support/electron-stub')
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-b64-'))
  process.env.FLEETBOARD_HOME = dir2
  const roots = await import('../../src/main/roots')
  const fsops = await import('../../src/main/fsops')
  fsops.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: (() => ({})) as never, emit: () => {} })
  roots.grant(dir2)

  const real = path.join(dir2, 'real.png')
  const link = path.join(dir2, 'link.png')
  fs.writeFileSync(real, 'old')
  fs.symlinkSync(real, link)
  await ipcMain.invoke('fs:writeBase64', link, Buffer.from('new bytes').toString('base64'))
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'still a link')
  assert.equal(fs.readFileSync(real, 'utf8'), 'new bytes', 'written where it points')
  assert.deepEqual(fs.readdirSync(dir2).filter((f) => f.includes('fleetboard-')), [], 'no temporary file left behind')
})
