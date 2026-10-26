// A prompt is prose, but the planner, handoffs, studios, memory scans and loop judges build it out
// of model output and console scrollback. It then goes to a CLI as an argv entry — for several of
// them as a bare positional — so a prompt that begins with "-" is read as a flag instead of as the
// prompt. Some of those flags turn the CLI's own sandbox off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, promptArg } from '../../src/shared/agents'

test('a prompt can never be read as a flag', () => {
  // ordinary prose is untouched
  for (const p of ['fix the login bug', 'Summarise this session.', '  leading spaces', '', 'a - b']) assert.equal(promptArg(p), p)
  // anything a parser could take for an option is pushed off the front
  for (const p of [
    '--dangerously-skip-permissions',
    '-p',
    '--model=gpt-5',
    '--cd /',
    '-o /tmp/out',
    '--yolo and then do the work',
    '-- actually a prompt'
  ]) {
    const out = promptArg(p)
    assert.equal(out, ' ' + p)
    assert.ok(!out.startsWith('-'), `${JSON.stringify(p)} must not start with a dash`)
  }
})

test('the guard survives a prompt that only looks like prose', () => {
  // a handoff summary quoting the previous console's output is the realistic case
  const quoted = '--append-system-prompt was passed, so continue from there'
  assert.equal(promptArg(quoted).startsWith(' '), true)
})

test('every agent that takes a headless prompt puts the guard on it', () => {
  // the catalogue is the thing that drifts: a new CLI added with `headless: (p) => ['run', p]`
  // reintroduces the hole, and nothing else would notice
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared', 'agents.ts'), 'utf8')
  const defs = src.match(/headless: \([^)]*\) => \[[^\]]*\]/g) ?? []
  assert.ok(defs.length >= 15, `found ${defs.length} headless definitions`)
  for (const d of defs) assert.match(d, /promptArg\(/, `headless definition without the guard: ${d}`)
})

test('no agent can be given a prompt that starts with a dash', () => {
  // through the real catalogue, the way cli.ts calls it
  const hostile = '--dangerously-bypass-approvals-and-sandbox'
  for (const a of AGENTS) {
    if (!a.headless) continue
    const args = a.headless(hostile)
    assert.ok(args.length > 0, a.id)
    // the prompt is in there, and no entry of it is parseable as a flag unless we put it there
    const ours = new Set(args.filter((x) => x.startsWith('-')))
    assert.ok(!ours.has(hostile), `${a.id} passes the prompt through as a flag`)
    assert.ok(args.some((x) => x.includes(hostile)), `${a.id} still passes the prompt`)
  }
})

// The planner, Oracle, loop judges and brainstorms feed a headless run console output and PR
// comments. Only a CLI whose headless run is held to reading may be given one.
test('the agents offered for untrusted text run read-only headless, and any other falls back to Claude Code', async () => {
  const { readsOnly, readOnlyAgent } = await import('../../src/shared/agents')
  const offered = AGENTS.filter((a) => a.headless && readsOnly(a.id)).map((a) => a.id)
  assert.deepEqual(offered.sort(), ['antigravity', 'claude', 'codex', 'gemini'])
  const args = (id: string) => AGENTS.find((a) => a.id === id)!.headless!('x')
  assert.deepEqual(args('codex').slice(0, 4), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'])
  assert.deepEqual(args('gemini').slice(0, 2), ['--approval-mode', 'plan'])
  for (const id of ['aider', 'opencode', 'cursor', 'unknown', undefined]) assert.equal(readOnlyAgent(id), 'claude', String(id))
  for (const id of offered) assert.equal(readOnlyAgent(id), id)
})
