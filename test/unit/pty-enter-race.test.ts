// A real PTY running the fake claude: a board message that arrives while the agent works, just before
// it asks for permission, must not have its Enter taken as the answer (Enter picks "Yes").
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-race-'))
const log = path.join(dir, 'fake.log')
let ptys: import('../../src/main/pty').PtyManager

before(async () => {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const fake = path.resolve(import.meta.dirname, '../fake-agent/claude.mjs')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  process.env.SHELL = '/bin/false'
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.FAKE_CLAUDE_SCENARIO = JSON.stringify({
    solo: [
      { match: '^start', workMs: 1500, bash: 'rm -rf ./build', reply: 'ok' },
      { match: '.', workMs: 100, reply: 'ok' }
    ]
  })
  const { PtyManager } = await import('../../src/main/pty')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  ptys = new PtyManager(() => null, () => DEFAULT_SETTINGS)
})
after(() => ptys?.dispose())

const events = (name: string) =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === name)
    : []
async function until(fn: () => unknown, ms = 20_000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${fn}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('a message sent just before a permission dialog does not answer it, and arrives after', async () => {
  await ptys.spawn({ id: 'c1', agentId: 'claude', cwd: dir, cols: 100, rows: 30 })
  await until(() => ptys.status('c1') === 'idle', 30_000)
  await new Promise((r) => setTimeout(r, 1500))
  ptys.send('c1', 'start the job', true)
  await until(() => events('prompt').some((e) => e.prompt === 'start the job'))
  // working; a loop's message arrives 50 ms before the agent asks
  await new Promise((r) => setTimeout(r, 1450))
  ptys.send('c1', 'continue with the next task', true)
  await until(() => ptys.status('c1') === 'needs-you', 5000)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(events('dialog-answer').length, 0, 'the board typed no answer')
  // the user answers; then the message is submitted
  assert.deepEqual(await ptys.answer('c1', { option: 'No' }), { ok: true })
  await until(() => events('prompt').some((e) => /continue with the next task/.test(e.prompt)), 10_000)
  assert.equal(events('dialog-answer')[0].choice, 2, 'the answer was the user’s')
})
