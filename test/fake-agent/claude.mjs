#!/usr/bin/env node
// A scripted stand-in for Claude Code, for end-to-end tests. It is started by the app exactly like the
// real CLI (same flags) and behaves like it where Fleetboard can tell:
//  - draws a Claude-like TUI: hidden cursor, an input box between rules, permission dialogs with a
//    numbered menu, a spinner while working; reads keys in raw mode, bracketed paste included
//  - runs the hook commands from --settings (SessionStart, UserPromptSubmit, PreToolUse,
//    PermissionRequest, PostToolUse, Stop) with a JSON payload on stdin, like Claude Code
//  - speaks MCP over HTTP to the server in --mcp-config (the fleet tools)
//  - -p: prints a stream-json reply like `claude -p --output-format stream-json`
//  - keeps conversations like Claude Code: <config>/projects/<cwd>/<id>.jsonl once something is said;
//    --session-id, --resume <id> and --continue pick one (with the CLI's errors), /clear starts anew
// What it does is decided by a scenario (JSON in FAKE_CLAUDE_SCENARIO, inline or a file path).
// Every step is appended to FAKE_CLAUDE_LOG (JSON lines) so tests can check what happened.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// ------------------------------------------------------------------ args and scenario

const argv = process.argv.slice(2)
const opts = { allowed: [], disallowed: [] }
/** the conversation this run is in */
let session
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => argv[++i]
  const list = () => {
    const out = []
    while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.push(argv[++i])
    return out
  }
  if (a === '-p' || a === '--print') opts.print = argv[i + 1] && !argv[i + 1].startsWith('-') ? val() : ''
  else if (a === '--settings') opts.settings = val()
  else if (a === '--mcp-config') opts.mcpConfig = val()
  else if (a === '--append-system-prompt') opts.system = val()
  else if (a === '--permission-mode') opts.mode = val()
  else if (a === '--model') opts.model = val()
  else if (a === '--output-format') opts.format = val()
  else if (a === '--allowedTools') opts.allowed.push(...list())
  else if (a === '--disallowedTools') opts.disallowed.push(...list())
  else if (a === '--continue' || a === '-c') opts.cont = true
  else if (a === '--resume' || a === '-r') opts.resumeId = argv[i + 1] && !argv[i + 1].startsWith('-') ? val() : ''
  else if (a === '--session-id') opts.sessionId = val()
  else if (a === '--dangerously-skip-permissions') opts.mode = 'bypassPermissions'
}

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n')
  process.exit(0)
}

function readScenario() {
  const raw = process.env.FAKE_CLAUDE_SCENARIO
  if (!raw) return {}
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'))
  } catch (e) {
    return { error: String(e) }
  }
}
const scenario = readScenario()

const roleMatch = /You are (.+?), (the Lead|a worker|a reviewer)/.exec(opts.system ?? '')
const me = { name: roleMatch?.[1] ?? 'Solo', role: roleMatch ? (roleMatch[2] === 'the Lead' ? 'lead' : roleMatch[2] === 'a worker' ? 'worker' : 'reviewer') : 'solo' }

function log(event, data = {}) {
  const file = process.env.FAKE_CLAUDE_LOG
  if (!file) return
  try {
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, name: me.name, role: me.role, cwd: process.cwd(), event, ...data }) + '\n')
  } catch {
    /* tests read what they can */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ headless (-p)

if (opts.print !== undefined) {
  let prompt = opts.print
  if (!prompt && !process.stdin.isTTY) {
    // like the real CLI: no prompt argument means it comes on stdin (read as a stream: large
    // prompts do not fit in the pipe buffer at once)
    prompt = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) prompt += chunk
  }
  log('print', { prompt: prompt.slice(0, 4000), promptLength: prompt.length, args: argv.filter((a) => a !== opts.print) })
  const rules = scenario.print ?? []
  const rule = rules.find((r) => new RegExp(r.match ?? '', 'is').test(prompt))
  const reply = rule?.reply ?? 'ok'
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  if (opts.format === 'stream-json') {
    out({ type: 'system', subtype: 'init', model: opts.model ?? 'fake' })
    out({ type: 'stream_event', event: { type: 'message_start' } })
    for (const piece of reply.match(/[\s\S]{1,40}/g) ?? []) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } })
      await sleep(5)
    }
    // the real CLI exits 0 after a run that ended in an error, and says so in its result
    // noResult: the stream stops before its result, as when the CLI dies mid-run
    if (!rule?.noResult) out(rule?.isError ? { type: 'result', subtype: 'error_max_turns', is_error: true, result: reply } : { type: 'result', subtype: 'success', result: reply })
  } else process.stdout.write(reply + '\n')
  process.exit(rule?.exit ?? 0)
}

// ------------------------------------------------------------------ hooks

const settings = (() => {
  try {
    return opts.settings ? JSON.parse(fs.readFileSync(opts.settings, 'utf8')) : {}
  } catch {
    return {}
  }
})()

async function hook(event, payload = {}) {
  const groups = settings.hooks?.[event] ?? []
  const body = JSON.stringify({ hook_event_name: event, session_id: session ?? 'fake', cwd: process.cwd(), permission_mode: opts.mode ?? 'default', ...payload })
  for (const g of groups) {
    if (g.matcher && g.matcher !== '*' && payload.tool_name && !new RegExp(g.matcher).test(payload.tool_name)) continue
    for (const h of g.hooks ?? []) {
      if (h.type !== 'command') continue
      await new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', h.command], { stdio: ['pipe', 'ignore', 'ignore'] })
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.on('close', () => (clearTimeout(timer), resolve()))
        child.on('error', () => (clearTimeout(timer), resolve()))
        child.stdin.end(body)
      })
    }
  }
  log('hook', { hook: event, tool: payload.tool_name })
}

// ------------------------------------------------------------------ conversations

const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
const transcriptOf = (id) => path.join(projectsDir, `${id}.jsonl`)
/** the prompts said in a conversation, or null if it was never saved */
function history(id) {
  try {
    return fs.readFileSync(transcriptOf(id), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).prompt)
  } catch {
    return null
  }
}
// ------------------------------------------------------------------ MCP

// like Claude Code, ${VAR} in a server's headers is read from the environment (the fleet's bearer
// token is kept out of the file that way)
const expand = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => process.env[k] ?? '')
const mcpServer = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(opts.mcpConfig, 'utf8'))
    const server = Object.values(cfg.mcpServers ?? {})[0]
    return server && { ...server, headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expand(v)])) }
  } catch {
    return undefined
  }
})()
const mcpUrl = mcpServer?.url
let rpcId = 0
async function rpc(method, params, signal) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...mcpServer.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}
let mcpReady = null
async function tool(name, args, { abortAfterMs } = {}) {
  if (!mcpUrl) throw new Error('no MCP server configured')
  mcpReady ??= rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } })
  await mcpReady
  const full = `mcp__fleet__${name}`
  await hook('PreToolUse', { tool_name: full, tool_input: args })
  transcript(`● fleet - ${name} (MCP)`)
  // a call whose connection drops midway, like a CLI that was interrupted or restarted
  if (abortAfterMs) {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), abortAfterMs)
    try {
      await rpc('tools/call', { name, arguments: args }, ctl.signal)
    } catch {
      log('tool-aborted', { tool: name })
      transcript('  ⎿  Interrupted')
      return { text: '', isError: true, aborted: true }
    }
  }
  const r = await rpc('tools/call', { name, arguments: args })
  const text = (r.content ?? []).map((c) => c.text).join('\n')
  log('tool', { tool: name, args, result: text.slice(0, 2000), isError: !!r.isError })
  transcript(`  ⎿  ${text.split('\n')[0].slice(0, 90)}`)
  await hook('PostToolUse', { tool_name: full, tool_input: args })
  return { text, isError: !!r.isError }
}

// ------------------------------------------------------------------ screen

const out = (s) => process.stdout.write(s)
const lines = []
let state = 'idle' // idle | working | dialog
let input = ''
let dialog = null // { title, detail, question, options, selected, resolve }
let spin = 0
const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30
const rule = () => '─'.repeat(cols())

function transcript(line) {
  lines.push(...String(line).split('\n'))
  if (lines.length > 500) lines.splice(0, lines.length - 500)
  draw()
}

function draw() {
  const bottom = []
  if (state === 'dialog' && dialog?.plain) {
    // a startup question like Claude Code's "Make auto mode your default permission mode?": no numbers, no hint
    bottom.push(rule(), ` ${dialog.question}`, `   ${dialog.explain}`)
    dialog.options.forEach((o, i) => bottom.push(`   ${i === dialog.selected ? '❯' : ' '} ${o}`))
  } else if (state === 'dialog' && dialog) {
    // laid out like Claude Code's: header, then the command between dashed rules, then the question
    const dashed = '╌'.repeat(cols())
    bottom.push(rule(), ` ${dialog.title}`, '', dashed, ...dialog.detail.map((d) => ` ${d}`), dashed, ` ${dialog.question}`)
    dialog.options.forEach((o, i) => bottom.push(`${i === dialog.selected ? ' ❯' : '  '} ${i + 1}. ${o}`))
    bottom.push('', ' Esc to cancel')
  } else {
    if (state === 'working') bottom.push(`${'✢✳✶✻✽'[spin % 5]} Working… (esc to interrupt)`, '')
    bottom.push(rule(), `❯ ${input}`, rule(), state === 'working' ? '  esc to interrupt' : '  ? for shortcuts')
  }
  const room = Math.max(0, rows() - bottom.length)
  const top = lines.slice(-room)
  while (top.length < room) top.unshift('')
  // full redraw: home, every row cleared and rewritten
  out('\x1b[H' + [...top, ...bottom].map((l) => '\x1b[2K' + l.slice(0, cols())).join('\r\n'))
}

// ------------------------------------------------------------------ permission dialogs

function allowedWithoutAsking(toolName) {
  if (opts.mode === 'bypassPermissions') return true
  if (opts.mode === 'acceptEdits' && /^(Write|Edit|MultiEdit)$/.test(toolName)) return true
  return opts.allowed.some((a) => a === toolName || toolName.startsWith(a))
}

async function permission(toolName, detail, title = toolName === 'Bash' ? 'Bash command' : 'Create file') {
  if (allowedWithoutAsking(toolName)) return true
  await hook('PermissionRequest', { tool_name: toolName, tool_input: { detail } })
  log('dialog', { tool: toolName, detail })
  const choice = await new Promise((resolve) => {
    dialog = { title, detail: [detail], question: 'Do you want to proceed?', options: ['Yes', "Yes, and don't ask again for this command", 'No'], selected: 0, resolve }
    state = 'dialog'
    draw()
  })
  dialog = null
  state = 'working'
  draw()
  log('dialog-answer', { tool: toolName, choice })
  if (choice === 1) opts.allowed.push(toolName)
  return choice !== 2
}

// ------------------------------------------------------------------ tools the agent "uses"

async function writeFile(file, content) {
  const ok = await permission('Write', file)
  if (!ok) {
    transcript(`● Write(${file})\n  ⎿  User rejected write`)
    return false
  }
  await hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: file } })
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, content)
  transcript(`● Write(${file})\n  ⎿  Wrote ${content.split('\n').length} lines to ${file}`)
  log('write', { file })
  await hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } })
  return true
}

// ------------------------------------------------------------------ behaviors

const fill = (s) => String(s ?? '').replace(/\{name\}/g, me.name)

async function leadFlow(goal) {
  const sc = scenario.lead ?? {}
  const tasks = sc.tasks ?? [{ task: `Do: ${goal}`, owns: ['work.txt'], done_when: 'work.txt exists' }]
  await tool('fleet_plan', { tasks: tasks.map((t) => t.title ?? t.task), ...(tasks.some((t) => t.estimate) ? { estimates: tasks.map((t) => t.estimate ?? 0) } : {}) })
  const started = []
  for (const t of tasks) {
    const r = await tool('fleet_spawn_worker', { task: t.task, owns: t.owns, done_when: t.done_when, name: t.name, agent: t.agent, task_ref: 'ref' in t ? (t.ref ?? undefined) : (t.title ?? t.task) })
    const name = /^(.+?) started/.exec(r.text)?.[1]
    if (name) started.push(name)
  }
  if (sc.crashAfterSpawn) {
    log('crash')
    process.exit(2)
  }
  if (sc.ask) {
    const r = await tool('fleet_ask_user', { question: sc.ask.question, options: sc.ask.options, notes: sc.ask.notes, recommended: sc.ask.recommended })
    log('answer', { text: r.text })
  }
  // collect reports, merging finished work as it comes in
  const pending = new Set(started)
  const deadline = Date.now() + (sc.waitMs ?? 120_000)
  let firstWait = true
  while (pending.size && Date.now() < deadline) {
    const r = await tool('fleet_wait', { timeout_seconds: sc.waitSeconds ?? 20 }, { abortAfterMs: firstWait ? sc.abortFirstWaitMs : undefined })
    firstWait = false
    // interrupted: the lead does something else for a while before it listens again
    if (r.aborted && sc.pauseAfterAbortMs) await sleep(sc.pauseAfterAbortMs)
    log('wait-result', { text: r.text.slice(0, 500) })
    for (const m of r.text.matchAll(/\[Fleet\] (.+?) reported: \((\w+)\)/g)) {
      const [, who, status] = m
      if (!pending.has(who)) continue
      pending.delete(who)
      if (status === 'done') {
        const merged = await tool('fleet_merge', { worker: who })
        log('merged', { worker: who, ok: !merged.isError, text: merged.text })
      }
    }
  }
  if (pending.size) log('gave-up', { waitingFor: [...pending] })
  if (sc.review) {
    await tool('fleet_spawn_reviewer', { scope: `Check: ${goal}` })
    const until = Date.now() + 60_000
    while (Date.now() < until) {
      const r = await tool('fleet_wait', { timeout_seconds: 20 })
      if (/reported: \((approve|changes)\)/.test(r.text)) break
    }
  }
  if (sc.finish !== false) await tool('fleet_finish', { summary: fill(sc.summary ?? `Done: ${goal}`), verified: sc.verified })
}

/** After a restart: wait for the workers the briefing says are still working, merge, finish. */
async function leadResumeFlow(briefing) {
  const sc = scenario.lead ?? {}
  await tool('fleet_status', {})
  const pending = new Set([...briefing.matchAll(/([^;:.]+?) \(worker\): still working/g)].map((m) => m[1].trim()))
  const unmerged = [...briefing.matchAll(/([^;:.]+?) \(worker\): reported/g)].map((m) => m[1].trim())
  log('resume', { waitingFor: [...pending], unmerged })
  for (const who of unmerged) {
    const merged = await tool('fleet_merge', { worker: who })
    log('merged', { worker: who, ok: !merged.isError, text: merged.text })
  }
  const deadline = Date.now() + (sc.waitMs ?? 120_000)
  while (pending.size && Date.now() < deadline) {
    const r = await tool('fleet_wait', { timeout_seconds: sc.waitSeconds ?? 20 })
    log('wait-result', { text: r.text.slice(0, 500) })
    for (const m of r.text.matchAll(/\[Fleet\] (.+?) reported: \((\w+)\)/g)) {
      if (!pending.delete(m[1])) continue
      if (m[2] === 'done') {
        const merged = await tool('fleet_merge', { worker: m[1] })
        log('merged', { worker: m[1], ok: !merged.isError, text: merged.text })
      }
    }
  }
  if (pending.size) log('gave-up', { waitingFor: [...pending] })
  await tool('fleet_finish', { summary: fill(sc.summary ?? 'Done after a restart') })
}

async function workerFlow(brief) {
  const all = scenario.workers ?? {}
  const sc = all[me.name] ?? all['*'] ?? {}
  if (sc.delayMs) await sleep(sc.delayMs)
  if (sc.crash) {
    log('crash')
    process.exit(sc.crash === true ? 1 : sc.crash)
  }
  if (sc.bash) {
    const ok = await permission('Bash', sc.bash)
    transcript(`● Bash(${sc.bash})\n  ⎿  ${ok ? 'Done' : 'User rejected'}`)
  }
  const owns = /You own: (.+?)\.(?:\s|$)/.exec(brief)?.[1]?.split(", ") ?? []
  const files = sc.files ?? Object.fromEntries(owns.map((f) => [f, `${me.name} was here\n`]))
  for (const [file, content] of Object.entries(files)) await writeFile(file, fill(content))
  // the work is on disk but not reported yet: what the live diff is for
  if (sc.holdMs) await sleep(sc.holdMs)
  if (sc.report === false) return
  await tool('fleet_report', { status: sc.status ?? 'done', summary: fill(sc.summary ?? `Wrote ${Object.keys(files).join(', ')}`) })
}

async function reviewerFlow() {
  const sc = scenario.reviewer ?? {}
  await tool('fleet_report', { status: sc.verdict ?? 'approve', summary: sc.summary ?? 'Looks good.' })
}

async function soloFlow(prompt) {
  const rule = (scenario.solo ?? []).find((r) => new RegExp(r.match ?? '', 'is').test(prompt))
  await sleep(rule?.workMs ?? 600)
  if (rule?.bash) {
    const ok = await permission('Bash', rule.bash)
    transcript(`● Bash(${rule.bash})${rule.holdMs ? '' : `\n  ⎿  ${ok ? 'Done' : 'User rejected'}`}`)
    // still running, the way a long command looks: its line drawn, the spinner going, no result yet
    if (rule.holdMs) {
      await sleep(rule.holdMs)
      transcript(`  ⎿  ${ok ? 'Done' : 'User rejected'}`)
    }
  }
  if (rule?.write) for (const [f, c] of Object.entries(rule.write)) await writeFile(f, c)
  transcript(`● ${rule?.reply ?? `Done: ${prompt.slice(0, 60)}`}`)
}

async function turn(prompt) {
  if (prompt === '/clear') {
    session = crypto.randomUUID()
    log('clear', { session })
    transcript('⎿ (no content)')
    await hook('SessionStart', { source: 'clear' })
    return draw()
  }
  state = 'working'
  log('prompt', { prompt, session })
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.appendFileSync(transcriptOf(session), JSON.stringify({ type: 'user', sessionId: session, prompt }) + '\n')
  transcript(`❯ ${prompt}`)
  await hook('UserPromptSubmit', { prompt })
  const spinner = setInterval(() => {
    spin++
    if (state === 'working') draw()
  }, 100)
  try {
    if (me.role === 'lead' && /\[Fleet\] (Fleetboard|Your console) was restarted/.test(prompt)) await leadResumeFlow(prompt)
    else if (me.role === 'lead' && /^\[Fleet\] .+ reported: \(/.test(prompt)) log('report-typed', { prompt })
    else if (me.role === 'lead' && !prompt.startsWith('[Fleet]')) await leadFlow(prompt)
    else if (me.role === 'worker' && prompt.includes('Task from')) await workerFlow(prompt)
    else if (me.role === 'reviewer' && prompt.includes('Task from')) await reviewerFlow()
    else if (me.role === 'solo') await soloFlow(prompt)
    else await sleep(300)
  } catch (e) {
    log('error', { error: String(e?.stack ?? e) })
    transcript(`● Error: ${String(e).slice(0, 200)}`)
  }
  clearInterval(spinner)
  state = 'idle'
  draw()
  await hook('Stop', {})
}

// ------------------------------------------------------------------ input

const queue = []
let busy = false
async function submit(text) {
  queue.push(text)
  if (busy) return
  busy = true
  while (queue.length) await turn(queue.shift())
  busy = false
}

let pasting = false
function onKeys(data) {
  log('keys', { data })
  let s = data
  while (s.length) {
    if (s.startsWith('\x1b[200~')) {
      pasting = true
      s = s.slice(6)
      continue
    }
    if (s.startsWith('\x1b[201~')) {
      pasting = false
      s = s.slice(6)
      continue
    }
    if (pasting) {
      const end = s.indexOf('\x1b[201~')
      const chunk = end < 0 ? s : s.slice(0, end)
      if (state !== 'dialog') input += chunk.replace(/[\r\n]+/g, ' ')
      s = end < 0 ? '' : s.slice(end)
      continue
    }
    const seq = /^(\x1b\[[AB]|\x1bO[AB]|\x1b\[[IO]|\x1b)/.exec(s)?.[0]
    if (seq) {
      s = s.slice(seq.length)
      if (state === 'dialog' && dialog) {
        if (/[A]$/.test(seq)) dialog.selected = Math.max(0, dialog.selected - 1)
        else if (/[B]$/.test(seq)) dialog.selected = Math.min(dialog.options.length - 1, dialog.selected + 1)
        else if (seq === '\x1b') dialog.resolve(dialog.options.length - 1)
      }
      continue
    }
    const ch = s[0]
    s = s.slice(1)
    if (ch === '\x03') {
      log('exit', { reason: 'ctrl-c' })
      out('\x1b[?25h\r\n')
      process.exit(0)
    }
    if (state === 'dialog' && dialog) {
      if (ch === '\r') dialog.resolve(dialog.selected)
      else if (/[1-9]/.test(ch) && Number(ch) <= dialog.options.length) dialog.resolve(Number(ch) - 1)
      continue
    }
    if (ch === '\r') {
      const text = input.trim()
      input = ''
      if (text) void submit(text)
    } else if (ch === '\x7f' || ch === '\b') input = input.slice(0, -1)
    else if (ch === '\x15') input = ''
    else if (ch >= ' ') input += ch
  }
  draw()
}

// ------------------------------------------------------------------ start

{
  const fail = (msg) => {
    log('session-error', { message: msg })
    process.stderr.write(msg + '\n')
    process.exit(1)
  }
  if (opts.resumeId !== undefined) {
    if (!opts.resumeId) fail('Error: the session picker needs a person (pass a session id)')
    if (!history(opts.resumeId)) fail(`No conversation found with session ID: ${opts.resumeId}`)
    session = opts.resumeId
  } else if (opts.cont) {
    const latest = (() => {
      try {
        return fs
          .readdirSync(projectsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ f, t: fs.statSync(path.join(projectsDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0]?.f
      } catch {
        return undefined
      }
    })()
    if (!latest) fail('No conversation found to continue')
    session = latest.replace(/\.jsonl$/, '')
  } else if (opts.sessionId) {
    if (history(opts.sessionId)) fail(`Error: Session ID ${opts.sessionId} is already in use.`)
    session = opts.sessionId
  } else session = crypto.randomUUID()
  opts.resumed = opts.resumeId !== undefined || !!opts.cont
}
log('start', { args: argv, mode: opts.mode, allowed: opts.allowed, resumed: !!opts.resumed, mcp: !!mcpUrl, session, history: history(session) ?? [] })
// what the real CLI would send to the fleet server, once ${FB_MCP_TOKEN} is expanded: for the tests that
// call that server as one member or another (the config file names the variable, never the token)
if (mcpUrl) log('mcp-auth', { url: mcpUrl, headers: mcpServer.headers })
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onKeys)
process.stdout.on('resize', draw)
out('\x1b[?25l\x1b[?2004h\x1b[2J')
transcript(`✻ Fake Claude Code${me.role !== 'solo' ? ` (${me.name}, ${me.role})` : ''}`)
await sleep(scenario.startMs ?? 300)
await hook('SessionStart', { source: opts.resumed ? 'resume' : 'startup' })
draw()
if (scenario.startupMenu) {
  // drawn a moment after SessionStart, like Claude Code's own
  await sleep(scenario.startupMenu.afterMs ?? 600)
  const choice = await new Promise((resolve) => {
    dialog = { plain: true, question: scenario.startupMenu.question, explain: scenario.startupMenu.explain ?? '', options: scenario.startupMenu.options, selected: 0, resolve }
    state = 'dialog'
    draw()
  })
  dialog = null
  state = 'idle'
  log('startup-answer', { choice: scenario.startupMenu.options[choice] })
  draw()
}
