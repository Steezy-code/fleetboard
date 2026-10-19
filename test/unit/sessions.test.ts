// Whether a CLI saved a conversation under an id: decides between resuming it and starting it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasTranscript, newSessionId, validSessionId } from '../../src/main/sessions'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sessions-'))
const put = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
  fs.writeFileSync(path.join(home, rel), text)
}
const ID = '4a1f6a2e-9a55-4c1e-8e2b-0c3d5e6f7a8b'
const OTHER = '7b0c8a1e-1111-4222-8333-444455556666'

test('ids: only UUIDs, which is what the CLIs accept', () => {
  assert.ok(validSessionId(newSessionId()))
  assert.notEqual(newSessionId(), newSessionId())
  for (const bad of ['', 'latest', '5', '../../etc/passwd', `${ID} --dangerously-skip-permissions`, `${ID}x`, null, 42]) assert.equal(validSessionId(bad), false, String(bad))
})

test('Claude Code: <config>/projects/<cwd>/<id>.jsonl, in the default or a profile config dir', () => {
  assert.equal(hasTranscript('claude', ID, { HOME: home }), false, 'no config dir yet')
  put(`.claude/projects/-home-me-repo/${OTHER}.jsonl`, '{}\n')
  assert.equal(hasTranscript('claude', ID, { HOME: home }), false)
  put(`.claude/projects/-home-me-other-repo/${ID}.jsonl`, '{}\n')
  assert.equal(hasTranscript('claude', ID, { HOME: home }), true, 'in any project folder (a console may have moved)')
  assert.equal(hasTranscript('claude', ID, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'profile') }), false, 'another config dir')
  put(`profile/projects/-x/${OTHER}.jsonl`)
  assert.equal(hasTranscript('claude', OTHER, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'profile') }), true)
  assert.equal(hasTranscript('claude', '..', { HOME: home }), false)
})

test('Gemini CLI: ~/.gemini/tmp/<project>/chats/session-<time>-<id prefix>.jsonl holding the id', () => {
  assert.equal(hasTranscript('gemini', ID, { HOME: home }), false)
  put(`.gemini/tmp/demo/chats/session-2026-10-19T07-24-${ID.slice(0, 8)}.jsonl`, JSON.stringify({ sessionId: ID, kind: 'main' }) + '\n')
  assert.equal(hasTranscript('gemini', ID, { HOME: home }), true)
  // same 8-character prefix, different conversation
  put(`.gemini/tmp/demo/chats/session-2026-10-19T07-25-${OTHER.slice(0, 8)}.json`, JSON.stringify({ sessionId: `${OTHER.slice(0, 8)}-0000-4000-8000-000000000000` }))
  assert.equal(hasTranscript('gemini', OTHER, { HOME: home }), false)
  put('.gemini/tmp/notes.txt', 'not a project dir')
  assert.equal(hasTranscript('gemini', ID, { HOME: home }), true)
})

test('CLIs without ids, and Codex with no sessions yet', () => {
  assert.equal(hasTranscript('aider', ID, { HOME: home }), false)
  assert.equal(hasTranscript('codex', ID, { HOME: home }), false)
})

// ---- Codex: no id at start; its session is found after the first turn ----

const { findCodexSession, readCodexSession } = await import('../../src/main/sessions')
const codexHome = path.join(home, 'codex')
let seq = 0
/** A rollout like the Codex TUI writes: session_meta, the context it adds, then what the user said. */
function rollout(id: string, cwd: string, startedAt: number, prompt?: string) {
  const day = new Date(startedAt)
  const dir = path.join(codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date(startedAt).toISOString()
  const lines: object[] = [
    { timestamp: ts, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd, originator: 'codex-tui', cli_version: '0.163.0', source: 'cli' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] } }
  ]
  if (prompt) lines.push({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } })
  fs.writeFileSync(path.join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, '-')}-${seq++}-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
const env = { HOME: home, CODEX_HOME: codexHome }
const T = Date.now()
const S1 = '01a152d6-d8a1-7553-afc2-db83baf0c7af'
const S2 = '01a152d7-afaf-7611-b8a8-24a055d3a617'
const S3 = '01a152d8-3526-7040-aa94-8183dd8fb6f5'

test('Codex: a rollout gives its id, folder and first prompt (not the context Codex adds)', () => {
  rollout(S1, '/work/app', T, 'fix the login bug')
  const files = fs.readdirSync(codexHome, { recursive: true }).map(String).filter((f) => f.endsWith(`${S1}.jsonl`))
  const s = readCodexSession(path.join(codexHome, files[0]))
  assert.deepEqual(s, { id: S1, cwd: '/work/app', startedAt: T, firstPrompt: 'fix the login bug' })
  assert.equal(hasTranscript('codex', S1, env), true)
  assert.equal(hasTranscript('codex', S2, env), false)
})

test('Codex: the console whose first prompt is on its screen gets the session', () => {
  rollout(S2, '/work/app', T + 50, 'add tests for the parser module please')
  const claimed = new Set<string>()
  const screen = (said: string) => `╭───╮\n│ >_ OpenAI Codex │\n╰───╯\n› ${said}\n• Working (2s • esc to interrupt)\n`
  // two consoles started in /work/app at T: each has its own
  assert.equal(findCodexSession(env, { cwd: '/work/app', since: T, claimed, screen: screen('fix the login bug') }), S1)
  assert.equal(findCodexSession(env, { cwd: '/work/app/', since: T, claimed, screen: screen('add tests for the parser\n  module please') }), S2, 'wrapped on screen')
  // claimed by another console
  assert.equal(findCodexSession(env, { cwd: '/work/app', since: T, claimed: new Set([S1]), screen: screen('fix the login bug') }), undefined)
  // another folder, or sessions from before this console started
  assert.equal(findCodexSession(env, { cwd: '/work/other', since: T, claimed, screen: screen('fix the login bug') }), undefined)
  assert.equal(findCodexSession(env, { cwd: '/work/app', since: T + 60_000, claimed, screen: screen('fix the login bug') }), undefined)
})

test("Codex: the only new session in the folder is not taken unless it is this console's", () => {
  rollout(S3, '/work/solo', T, 'refactor the cache layer')
  // this console's turn never reached the model; the only session is a sibling's
  assert.equal(findCodexSession(env, { cwd: '/work/solo', since: T, claimed: new Set(), screen: '› explain this repo\n■ stream error: 503' }), undefined)
  assert.equal(findCodexSession(env, { cwd: '/work/solo', since: T, claimed: new Set(), screen: '› refactor the cache layer' }), S3)
  // nothing said yet
  rollout('01a152d9-0000-7000-8000-000000000001', '/work/empty', T)
  assert.equal(findCodexSession(env, { cwd: '/work/empty', since: T, claimed: new Set(), screen: '' }), undefined)
})
