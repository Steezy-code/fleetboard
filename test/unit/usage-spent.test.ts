// What a team member spent, read from Claude Code's logs under a sandboxed home. Its subagents write
// their own logs a folder deeper, and a long worktree path is filed under a shortened name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-spent-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FLEETBOARD_HOME = path.join(home, '.fleetboard')
delete process.env.CLAUDE_CONFIG_DIR

const line = (id: string, input: number, session: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r' + id, sessionId: session, message: { id, model: 'claude-x', usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n'
const session = '11111111-1111-4111-8111-111111111111'
const projects = path.join(home, '.claude', 'projects')
const log = (folder: string, rel: string, id: string, input: number) => {
  const file = path.join(projects, folder, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, line(id, input, session))
}

const { spentIn, projectSlug } = await import('../../src/main/usage')

// the scan is cached for a while, so every log is written before the first read
const cwd = path.join(home, 'wt', 'w1')
log(projectSlug(cwd), `${session}.jsonl`, 'm1', 1000)
log(projectSlug(cwd), path.join(session, 'subagents', 'agent-a1.jsonl'), 'm2', 9000)
const long = path.join(home, 'wt', 'x'.repeat(230))
log(`${projectSlug(long).slice(0, 200)}-abc123`, `${session}.jsonl`, 'm3', 500)
// two folders with the same first 200 characters: which is whose cannot be told without the hash
const twin = path.join(home, 'wt', 'y'.repeat(230))
log(`${projectSlug(twin).slice(0, 200)}-abc123`, `${session}.jsonl`, 'm4', 700)
log(`${projectSlug(twin).slice(0, 200)}-def456`, `${session}.jsonl`, 'm5', 800)

test("a member's spend counts its subagents' logs", async () => {
  assert.equal((await spentIn([cwd]))[cwd]?.total, 10_000)
})

test('a worktree path over 200 characters is found under its shortened folder, only when that is unambiguous', async () => {
  const r = await spentIn([long, twin])
  assert.equal(r[long]?.total, 500)
  assert.equal(r[twin], null)
})
