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

test('other CLIs keep no ids', () => {
  assert.equal(hasTranscript('codex', ID, { HOME: home }), false)
})
