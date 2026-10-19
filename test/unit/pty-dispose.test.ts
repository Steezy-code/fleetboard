// Quitting ends every console's processes, also those of a CLI that ignores SIGHUP (Gemini CLI does):
// they used to outlive the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dispose-'))
process.env.SHELL = '/bin/sh'
process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
const { PtyManager } = await import('../../src/main/pty')
const { DEFAULT_SETTINGS } = await import('../../src/shared/types')

/** running (a zombie, killed but not yet reaped by its parent, does not count) */
const alive = (pid: number) => {
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}
async function until(fn: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return fn()
}

test('dispose ends consoles that ignore SIGHUP, and their children, before it returns', { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async () => {
  const ptys = new PtyManager(() => null, () => DEFAULT_SETTINGS)
  const pidFile = path.join(dir, 'child.pid')
  // a console whose program ignores SIGHUP and has a child that does too
  const info = await ptys.spawn({ id: 'stubborn', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: `trap '' HUP; sleep 600 & echo $! > ${pidFile}; wait` })
  const polite = await ptys.spawn({ id: 'polite', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: 'sleep 600' })
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 5000), 'child started')
  const child = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(alive(info.pid) && alive(child) && alive(polite.pid))

  const t0 = Date.now()
  await ptys.dispose()
  assert.ok(Date.now() - t0 < 2000, `quick: ${Date.now() - t0} ms`)
  assert.ok(await until(() => !alive(info.pid) && !alive(child) && !alive(polite.pid), 1000), 'nothing outlives the app')
})
