// cli:run (headless one-shot runs) against the fake claude, through the stubbed ipcMain.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cli-'))
const log = path.join(dir, 'fake.log')
const events: [string, ...unknown[]][] = []

before(async () => {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const fake = path.resolve(import.meta.dirname, '../fake-agent/claude.mjs')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\necho "gemini got $# args: $1 $2"\n`, { mode: 0o755 })
  // no login shell: the app falls back to this process's environment
  process.env.SHELL = '/bin/false'
  // leave out any real codex on this machine, so "not installed" stays true
  const rest = (process.env.PATH ?? '').split(':').filter((d) => d && !fs.existsSync(path.join(d, 'codex')))
  process.env.PATH = [bin, ...rest].join(':')
  process.env.FAKE_CLAUDE_LOG = log
  process.env.FAKE_CLAUDE_SCENARIO = JSON.stringify({ print: [{ match: 'summarize', reply: 'Here is the summary.' }, { match: 'run out', reply: 'Reached max turns', isError: true }] })
  process.env.FLEETBOARD_HOME = path.join(dir, 'fb')
  const cli = await import('../../src/main/cli')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  cli.register({ ipc: ipcMain as any, win: () => null, ptys: null as any, settings: () => DEFAULT_SETTINGS, emit: (...e: [string, ...unknown[]]) => void events.push(e) })
})

const run = (prompt: string, agentId?: string) => ipcMain.invoke('cli:run', { runId: `r${Math.random()}`, prompt, cwd: dir, agentId })
const lastPrint = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'print')
    .at(-1)

test('streams the reply and returns the final text', async () => {
  const r = await run('please summarize this')
  assert.deepEqual(r, { code: 0, text: 'Here is the summary.' })
  const chunks = events.filter((e) => e[0] === 'cli:chunk').map((e) => e[2])
  assert.equal(chunks.join(''), 'Here is the summary.')
})

test('a run Claude reports as an error is a failure, though it exits 0', async () => {
  // callers save what a run returns (a document, a charter): one that ended in an error is not that
  const r = await run('run out of turns')
  assert.deepEqual(r, { code: 1, text: 'Reached max turns' })
})

test('a prompt far over the command-line limit reaches claude whole (through stdin)', async () => {
  const big = 'summarize ' + 'x'.repeat(300_000)
  const r = await run(big)
  assert.equal(r.code, 0)
  assert.equal(r.text, 'Here is the summary.')
  assert.equal(lastPrint().promptLength, big.length)
  assert.ok(!lastPrint().args.some((a: string) => a.length > 1000), 'the prompt is not on the command line')
  // the whole argv: allowed tools add to the user's own settings, so the mode is pinned too, or a
  // defaultMode of bypassPermissions would let a run that reads console output do anything
  assert.deepEqual(lastPrint().args, [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'default',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'LS', 'Bash(git log:*)', 'Bash(git ls-files:*)', 'Bash(git status:*)'
  ])
})

test('a run allowed to change files says so in full, and only when asked', async () => {
  await ipcMain.invoke('cli:run', { runId: 'rw', prompt: 'summarize', cwd: dir, allowTools: true })
  assert.deepEqual(lastPrint().args, [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash', 'Read', 'Grep', 'Glob', 'LS', 'Bash(git log:*)', 'Bash(git ls-files:*)', 'Bash(git status:*)', 'Edit', 'Write'
  ])
})

test('other CLIs get a clear error instead of a crash when the prompt cannot fit in argv', async () => {
  const r = await run('y'.repeat(150_000), 'gemini')
  assert.equal(r.code, 1)
  assert.match(r.text, /too long to pass to Gemini CLI/)
  const ok = await run('short', 'gemini')
  assert.equal(ok.code, 0)
  assert.match(ok.text, /gemini got 4 args: --approval-mode plan/, 'held to reading, the prompt after -p')
})

test('an agent that is not installed is a clear error', async () => {
  await assert.rejects(run('hi', 'codex'), /not on your PATH/)
})
