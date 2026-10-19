// PtyManager with a real PTY running the fake claude: messages from the board never answer a question.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pty-'))
const log = path.join(dir, 'fake.log')
let ptys: import('../../src/main/pty').PtyManager

before(async () => {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const fake = path.resolve(import.meta.dirname, '../fake-agent/claude.mjs')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  process.env.SHELL = '/bin/false' // no login shell: the app uses this environment
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.FAKE_CLAUDE_SCENARIO = JSON.stringify({
    startupMenu: { question: 'Make auto mode your default permission mode?', explain: 'Auto mode handles permission prompts.', options: ['Yes, set auto mode as my default permission mode', 'No, keep manual mode'] },
    solo: [{ match: '.', workMs: 100, reply: 'ok' }]
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
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('a message sent while the CLI asks a question is held, then delivered after the answer', async () => {
  await ptys.spawn({ id: 'c1', agentId: 'claude', cwd: dir, cols: 100, rows: 30 })
  await until(() => ptys.status('c1') === 'needs-you')
  ptys.send('c1', 'hello there', true)
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(events('startup-answer').length, 0, 'the question was not answered by the message')
  assert.equal(events('prompt').length, 0, 'the message is held')
  assert.deepEqual(await ptys.answer('c1', { option: 'No, keep manual mode' }), { ok: true })
  await until(() => events('prompt').some((e) => e.prompt === 'hello there'), 30_000)
  assert.equal(events('startup-answer')[0].choice, 'No, keep manual mode')
})

test('with no question on screen a message is typed right away', async () => {
  const before = events('prompt').length
  await until(() => ptys.status('c1') === 'idle', 30_000)
  ptys.send('c1', 'second message', true)
  await until(() => events('prompt').length > before, 5000)
  assert.equal(events('prompt').at(-1).prompt, 'second message')
})
