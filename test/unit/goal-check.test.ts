// A loop's "stop when this command passes": run by the app in the project, decided by the exit code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SHELL = '/bin/sh'
const { runGoalCheck } = await import('../../src/main/goal')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-goal-'))

test('exit 0 is met; anything else is not, with the end of the output', async () => {
  fs.writeFileSync(path.join(dir, 'ok.sh'), 'echo "3 passing"\n')
  assert.deepEqual(await runGoalCheck(dir, 'sh ok.sh'), { code: 0, tail: '3 passing\n' })
  const r = await runGoalCheck(dir, 'printf "\\033[31m1 failing\\033[0m\\n" >&2; exit 3')
  assert.equal(r.code, 3)
  assert.equal(r.tail, '1 failing\n', 'stderr too, colors removed')
})

test('it runs in the project folder', async () => {
  assert.equal((await runGoalCheck(dir, 'pwd')).tail.trim(), fs.realpathSync(dir))
})

test('too slow: stopped, with whatever it started', async () => {
  const marker = path.join(dir, 'child-alive')
  const t0 = Date.now()
  const r = await runGoalCheck(dir, `(sleep 2 && touch ${marker}) & sleep 30`, 500)
  assert.equal(r.code, null)
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - t0 < 5000)
  await new Promise((res) => setTimeout(res, 2500))
  assert.equal(fs.existsSync(marker), false, 'its background child was stopped too')
})

test('a missing folder or an empty command is an error, not a pass', async () => {
  assert.equal((await runGoalCheck(path.join(dir, 'nope'), 'true')).error?.startsWith('folder not found'), true)
  assert.equal((await runGoalCheck(dir, '  ')).error, 'no command')
})

test('stopped by its caller: ended at once, with whatever it started, and not read as a result', async () => {
  const marker = path.join(dir, 'stopped-child-alive')
  const ac = new AbortController()
  const t0 = Date.now()
  const p = runGoalCheck(dir, `(sleep 2 && touch ${marker}) & sleep 30`, 60_000, ac.signal)
  setTimeout(() => ac.abort(), 300)
  const r = await p
  assert.equal(r.code, null)
  assert.equal(r.error, 'stopped')
  assert.ok(Date.now() - t0 < 5000)
  await new Promise((res) => setTimeout(res, 2500))
  assert.equal(fs.existsSync(marker), false)
  assert.equal((await runGoalCheck(dir, 'true', 1000, ac.signal)).error, 'stopped', 'an already-stopped signal starts nothing')
})
