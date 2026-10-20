// Headless runs (the planner, studios, handoff summaries) and loop goal checks are child processes
// that the PTY manager knows nothing about, so dispose() never saw them. A planner run or an
// `npm test` goal check outlived the app: the goal check was spawned detached, as its own session
// leader, and carried on with the app gone — the headless one kept spending tokens with its output
// going nowhere, and the next launch's orphan reaper had no record of either.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-stray-'))
let cli: typeof import('../../src/main/cli')
let goal: typeof import('../../src/main/goal')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

before(async () => {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  // a "CLI" that never finishes on its own, so only the cleanup can end it
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 })
  // no login shell: loginEnv() then falls back to this process's environment, so the fake above is
  // the claude that cli:run finds (the same trick cli-run.test.ts uses)
  process.env.SHELL = '/bin/false'
  process.env.PATH = [bin, ...(process.env.PATH ?? '').split(':')].join(':')
  process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
  cli = await import('../../src/main/cli')
  goal = await import('../../src/main/goal')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  cli.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: () => DEFAULT_SETTINGS, emit: () => {} })
  goal.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: () => DEFAULT_SETTINGS, emit: () => {} })
})

test('quitting ends a headless run instead of leaving it to spend tokens', async () => {
  const before = new Set(pids())
  const promise = ipcMain.invoke('cli:run', { runId: 'stray-1', prompt: 'hello', cwd: dir })
  assert.ok(await until(() => pids().some((p) => !before.has(p))), 'the run started')
  const mine = pids().filter((p) => !before.has(p))

  cli.killRuns()
  assert.ok(await until(() => mine.every((p) => !alive(p))), 'every process it started is gone')
  // the pending invoke still settles, rather than hanging the caller for ever
  const r = (await promise) as { code: number }
  assert.equal(typeof r.code, 'number')
})

test('quitting ends a goal check, which is spawned detached', async () => {
  // a goal check runs the user's command in their shell, so it needs a real one; loginEnv is
  // already cached from the test above, so this does not change the PATH the CLI was found on
  process.env.SHELL = '/bin/sh'
  const before = new Set(pids())
  const promise = goal.runGoalCheck(dir, 'sleep 300', 60_000)
  assert.ok(await until(() => pids().some((p) => !before.has(p))), 'the check started')
  const mine = pids().filter((p) => !before.has(p))

  goal.killGoalChecks()
  assert.ok(await until(() => mine.every((p) => !alive(p))), 'the whole group is gone')
  const r = await promise
  assert.equal(r.code, null, 'it reports that it did not finish')
})

test('ending them twice, or with none running, is harmless', () => {
  cli.killRuns()
  cli.killRuns()
  goal.killGoalChecks()
  goal.killGoalChecks()
})

/** Every `sleep` process this test could have started. */
function pids(): number[] {
  try {
    return fs
      .readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('sleep')
        } catch {
          return false
        }
      })
      .map(Number)
  } catch {
    return []
  }
}
