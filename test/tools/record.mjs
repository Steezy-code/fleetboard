#!/usr/bin/env node
// Record a real CLI session in a PTY as an asciicast v2 file, driven by a small script of steps.
// The recordings are the corpus the console status tests replay (test/fixtures/casts).
//
//   node test/tools/record.mjs --out x.cast [--cols 100 --rows 30 --cwd dir --env K=V --timeout 60000]
//        --steps '[{"wait":"Dark mode"},{"send":"\r"},{"sleep":2000},{"mark":"after theme"}]' -- claude
//
// Steps: {wait: regex on the visible screen, timeout?}  {sleep: ms}  {send: text}  {mark: label}  {quiet: ms}  (quiet = no output for ms)
// A {mark} becomes an asciicast "m" event, which the tests use as a named point to check the status at.
//
// --hooks claude: run a hook server like the app's (src/main/hooks.ts) and pass Claude Code a settings
// file whose hooks post to it; every hook becomes an "h" event with [event name, payload].
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import xterm from '@xterm/xterm'
const require = createRequire(import.meta.url)
const pty = require('node-pty')

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
if (dash < 0) throw new Error('usage: record.mjs [options] -- command [args]')
const cmd = argv.slice(dash + 1)
const opt = { cols: 100, rows: 30, cwd: process.cwd(), env: [], steps: '[]', timeout: '90000' }
for (let i = 0; i < dash; i += 2) {
  const k = argv[i].replace(/^--/, '')
  if (k === 'env') opt.env.push(argv[i + 1])
  else opt[k] = argv[i + 1]
}
if (!opt.out) throw new Error('--out is required')

const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_SANDBOX|GEMINI_CLI_)/.test(k)) delete env[k]
for (const kv of opt.env) {
  const i = kv.indexOf('=')
  env[kv.slice(0, i)] = kv.slice(i + 1)
}

const t0 = Date.now()
const events = []

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd']
if (opt.hooks === 'claude') {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      res.writeHead(204).end()
      const m = /^\/hook\/[^/]+\/([A-Za-z]+)/.exec(req.url ?? '')
      if (!m) return
      let payload = null
      try {
        payload = JSON.parse(body)
      } catch {}
      // keep what classification could use; drop transcripts, paths and ids
      if (payload) for (const k of ['transcript_path', 'session_id', 'cwd', 'tool_response', 'last_assistant_message']) delete payload[k]
      events.push([(Date.now() - t0) / 1000, 'h', [m[1], payload]])
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.unref()
  const cmdHook = (event) => ({
    type: 'command',
    command: `curl -s -m 2 -X POST "http://127.0.0.1:\${FB_HOOK_PORT}/hook/\${FB_CONSOLE_ID}/${event}" --data-binary @- -o /dev/null >/dev/null 2>&1 || true`
  })
  const hooks = {}
  for (const e of HOOK_EVENTS) hooks[e] = [{ ...(/ToolUse|PermissionRequest/.test(e) ? { matcher: '*' } : {}), hooks: [cmdHook(e)] }]
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbrec-')), 'hooks.json')
  fs.writeFileSync(file, JSON.stringify({ hooks }))
  env.FB_HOOK_PORT = String(server.address().port)
  env.FB_CONSOLE_ID = 'rec'
  cmd.push('--settings', file)
}
let lastOut = Date.now()
// waits match what is on screen right now, as a terminal would show it
const term = new xterm.Terminal({ cols: +opt.cols, rows: +opt.rows, scrollback: 0, allowProposedApi: true })
const screenText = () => {
  const b = term.buffer.active
  const out = []
  for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  return out.join('\n')
}
const p = pty.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: +opt.cols, rows: +opt.rows, cwd: opt.cwd, env })
p.onData((d) => {
  events.push([(Date.now() - t0) / 1000, 'o', d])
  term.write(d)
  lastOut = Date.now()
})
let exited = false
p.onExit(() => (exited = true))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const killAt = Date.now() + +opt.timeout
  for (const step of JSON.parse(opt.steps)) {
    if (exited) break
    if (step.sleep) await sleep(step.sleep)
    if (step.send != null) {
      events.push([(Date.now() - t0) / 1000, 'i', step.send])
      p.write(step.send)
    }
    if (step.mark) events.push([(Date.now() - t0) / 1000, 'm', step.mark])
    if (step.wait) {
      const re = new RegExp(step.wait, 'im')
      const until = Date.now() + (step.timeout ?? 45000)
      while (!re.test(screenText())) {
        if (Date.now() > Math.min(until, killAt) || exited) throw new Error(`timed out waiting for /${step.wait}/`)
        await sleep(100)
      }
    }
    if (step.quiet) {
      // no output for `quiet` ms, counted from this step at the earliest
      const from = Date.now()
      while (Date.now() - Math.max(lastOut, from) < step.quiet) {
        if (Date.now() > killAt || exited) break
        await sleep(100)
      }
    }
  }
}

let failure = null
try {
  await run()
} catch (e) {
  failure = e
}
try {
  p.kill()
} catch {}
const header = { version: 2, width: +opt.cols, height: +opt.rows, timestamp: Math.floor(t0 / 1000), command: cmd.join(' ') }
fs.writeFileSync(opt.out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n')
if (failure) {
  console.error(String(failure.message))
  console.error('--- screen ---\n' + screenText())
  process.exit(1)
}
console.log(`wrote ${opt.out}: ${events.length} events`)
process.exit(0)
