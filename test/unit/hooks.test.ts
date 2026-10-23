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

test('the hook script (node) reports an event with its payload, and never fails the hook', async () => {
  const { NODE_HOOK } = await import('../../src/main/hooks')
  const { execFile } = await import('node:child_process')
  // async: the hook server runs in this process and must be free to answer
  const run = (args: string[], env: NodeJS.ProcessEnv, input: string) =>
    new Promise<void>((resolve) => {
      const child = execFile(process.execPath, args, { env }, () => resolve())
      child.stdin!.end(input)
    })
  const got: [string, string, unknown][] = []
  const port = await startHookServer((id, event, payload) => got.push([id, event, payload]))
  const script = path.join(process.env.FLEETBOARD_HOME!, 'fb-hook.cjs')
  fs.writeFileSync(script, NODE_HOOK)
  const env = { ...process.env, ...hookEnv('con_w'), FB_CONSOLE_ID: 'con_w' }
  await run([script, 'PreToolUse'], env, JSON.stringify({ tool_name: 'Bash' }))
  assert.deepEqual(got, [['con_w', 'PreToolUse', { tool_name: 'Bash' }]])
  // without the console's environment (or with a bad event name) it does nothing, quietly
  await run([script, 'Stop'], { ...process.env, FB_HOOK_PORT: '' }, '{}')
  await run([script, 'Bad/Event'], env, '{}')
  assert.equal(got.length, 1)
  void port
})

test('the hook command never puts the token on a command line where node is found', async () => {
  // every account on the machine can read another process's argv; curl's URL carried the token
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.FLEETBOARD_HOME!, 'hooks', 'claude-hooks.json'), 'utf8'))
  const commands: string[] = Object.values(settings.hooks).flatMap((h: any) => h[0].hooks.map((x: any) => x.command))
  assert.ok(commands.length > 0)
  for (const c of commands) {
    assert.doesNotMatch(c, /FB_HOOK_TOKEN/, c)
    assert.match(c, /fb-hook\.cjs" [A-Za-z]+$/)
  }
})
