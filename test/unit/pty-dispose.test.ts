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

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return '' // not there (yet)
  }
}
/** running (a zombie, killed but not yet reaped by its parent, does not count) */
const alive = (pid: number) => {
  const stat = read(`/proc/${pid}/stat`)
  return !!stat && !/^\d+ \(.*\) Z/.test(stat)
}
/** Does this process really ignore the hangup? SigIgn is the ignored-signal mask; SIGHUP is bit 0. */
const ignoresHup = (pid: number) => {
  const mask = /^SigIgn:\s*([0-9a-f]+)$/m.exec(read(`/proc/${pid}/status`))?.[1]
  return !!mask && (BigInt(`0x${mask}`) & 1n) === 1n
}
async function until(fn: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return fn()
}
/**
 * The pid of the job the shell put in the background, once it really ignores the hangup.
 *
 * `& echo $! > file` writes the pid at the fork, before the child has exec'd `nohup` or run its own
 * `trap '' HUP` — so for a moment that pid names a process the hangup still kills. Closing the
 * console inside that window killed the very job these tests say outlives it: one run in 120, with
 * the child still `nohup` and its SigIgn bit clear. Waiting for the pid was never enough; this waits
 * for the property the test depends on.
 */
const childFrom = async (pidFile: string) => {
  const written = () => Number(read(pidFile).trim())
  assert.ok(
    await until(() => written() > 0 && ignoresHup(written()), 5000),
    'the background job started and ignores the hangup'
  )
  return written()
}

test('dispose ends consoles that ignore SIGHUP, and their children, before it returns', { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async (t) => {
  const ptys = new PtyManager(() => null, () => DEFAULT_SETTINGS)
  // a failed check must not leave the consoles (and this test file) running
  t.after(() => ptys.dispose())
  const pidFile = path.join(dir, 'child.pid')
  // a console whose program ignores SIGHUP and has a child that does too
  const info = await ptys.spawn({ id: 'stubborn', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: `trap '' HUP; sleep 600 & echo $! > ${pidFile}; wait` })
  const polite = await ptys.spawn({ id: 'polite', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: 'sleep 600' })
  const child = await childFrom(pidFile)
  assert.ok(alive(info.pid) && alive(child) && alive(polite.pid))

  const t0 = Date.now()
  await ptys.dispose()
  assert.ok(Date.now() - t0 < 2000, `quick: ${Date.now() - t0} ms`)
  assert.ok(await until(() => !alive(info.pid) && !alive(child) && !alive(polite.pid), 1000), 'nothing outlives the app')
})

/** An agent CLI (as the catalog defines one) that ends on SIGHUP, with a child that ignores it. */
function agentWithStubbornChild(name: string) {
  const pidFile = path.join(dir, `${name}.pid`)
  const bin = path.join(dir, `${name}.sh`)
  fs.writeFileSync(bin, `#!/bin/sh\n(trap '' HUP; exec sleep 600) & echo $! > ${pidFile}\nwait\n`, { mode: 0o755 })
  const settings = { ...DEFAULT_SETTINGS, customAgents: [{ id: name, name, bin, color: '#888', vendor: 'test' }] }
  return { pidFile, settings }
}

test("quitting ends what an agent CLI started even when the CLI itself took the SIGHUP and ended", { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async (t) => {
  const { pidFile, settings } = agentWithStubbornChild('agent1')
  const ptys = new PtyManager(() => null, () => settings)
  t.after(() => ptys.dispose())
  const info = await ptys.spawn({ id: 'a', agentId: 'agent1', cwd: dir, cols: 80, rows: 24 })
  const child = await childFrom(pidFile)
  await ptys.dispose()
  assert.ok(await until(() => !alive(info.pid), 1000), 'the CLI ended')
  assert.ok(await until(() => !alive(child), 1000), 'and so did its child')
})

test('closing one agent console ends its CLI and what it started, even what ignores the hangup', { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async (t) => {
  const { pidFile, settings } = agentWithStubbornChild('agent2')
  const ptys = new PtyManager(() => null, () => settings)
  t.after(() => ptys.dispose())
  const info = await ptys.spawn({ id: 'one', agentId: 'agent2', cwd: dir, cols: 80, rows: 24 })
  const other = await ptys.spawn({ id: 'other', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: 'sleep 600' })
  const child = await childFrom(pidFile)
  ptys.kill('one')
  assert.ok(await until(() => !alive(info.pid), 1000), 'the CLI ended')
  assert.ok(await until(() => !alive(child), 4000), 'and its child, which ignored the hangup')
  assert.ok(alive(other.pid), 'other consoles are untouched')
})

test('a shell console is a terminal: what the user started with nohup outlives closing it', { skip: !fs.existsSync('/proc/self/stat') && 'needs /proc' }, async (t) => {
  const ptys = new PtyManager(() => null, () => DEFAULT_SETTINGS)
  t.after(() => ptys.dispose())
  const pidFile = path.join(dir, 'nohup.pid')
  const info = await ptys.spawn({ id: 'sh', agentId: 'shell', cwd: dir, cols: 80, rows: 24, command: `nohup sleep 600 >/dev/null 2>&1 & echo $! > ${pidFile}; wait` })
  const child = await childFrom(pidFile)
  t.after(() => {
    try {
      process.kill(child, 'SIGKILL')
    } catch {
      /* gone */
    }
  })
  ptys.kill('sh')
  assert.ok(await until(() => !alive(info.pid), 1000), 'the shell ended')
  await new Promise((r) => setTimeout(r, 3000))
  assert.ok(alive(child), 'the nohup job runs on, as after closing any terminal')
})
