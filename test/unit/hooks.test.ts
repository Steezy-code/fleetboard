// Claude Code's hook events reach the board through a local server: each console's token is good for
// that console's events only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hooks-'))
const { startHookServer, hookEnv } = await import('../../src/main/hooks')

test("a console's hook token reports for that console only", async () => {
  const got: [string, string][] = []
  const port = await startHookServer((id, event) => got.push([id, event]))
  const post = (token: string, id: string, event: string) =>
    fetch(`http://127.0.0.1:${port}/hook/${token}/${encodeURIComponent(id)}/${event}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '{}' }).then((r) => r.status)
  const a = hookEnv('con_a')
  const b = hookEnv('con_b')
  assert.equal(a.FB_HOOK_PORT, String(port))
  assert.notEqual(a.FB_HOOK_TOKEN, b.FB_HOOK_TOKEN, 'a token per console')
  assert.equal(await post(a.FB_HOOK_TOKEN, 'con_a', 'Stop'), 204)
  assert.equal(await post(a.FB_HOOK_TOKEN, 'con_b', 'SessionStart'), 403, "console a's token for console b")
  assert.equal(await post('x'.repeat(a.FB_HOOK_TOKEN.length), 'con_a', 'Stop'), 403)
  assert.equal(await post(b.FB_HOOK_TOKEN, 'con_b', 'Stop'), 204)
  assert.deepEqual(got, [
    ['con_a', 'Stop'],
    ['con_b', 'Stop']
  ])
})
