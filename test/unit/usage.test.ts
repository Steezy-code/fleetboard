// Token usage read from the CLIs' own session logs. The fixtures are real logs (prompts and paths
// removed): a Claude Code run, a Codex session resumed twice, a Gemini CLI chat with a tool call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-usage-'))
process.env.HOME = home
process.env.USERPROFILE = home // what os.homedir() reads on Windows
process.env.FLEETBOARD_HOME = path.join(home, 'fb')
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.CODEX_HOME
const { parseClaude, parseCodex, parseGemini, readLog, register } = await import('../../src/main/usage')
const { ipcMain } = await import('../support/electron-stub')

const FIX = path.resolve(import.meta.dirname, '../fixtures/usage')
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8')
const sum = (p: { events: number[][] | any[] }) =>
  p.events.reduce((a: number[], e: any[]) => [a[0] + e[2], a[1] + e[3], a[2] + e[4], a[3] + e[5]], [0, 0, 0, 0])

test('Claude Code: one count per API message, matching what the CLI itself reported', () => {
  const text = read('claude-session.jsonl')
  const p = parseClaude(text, 'x.jsonl')
  // the log writes each message once per content block (thinking, text, tool use)
  assert.equal(text.split('\n').filter((l) => l.includes('"type": "assistant"')).length, 4)
  assert.equal(p.events.length, 2)
  // Claude Code's own tally for the session, from its cost-state line
  const own = JSON.parse(text.trim().split('\n').find((l) => l.includes('"cost-state"'))!).modelUsage['claude-haiku-4-5']
  assert.deepEqual(sum(p), [own.inputTokens, own.outputTokens, own.cacheCreationInputTokens, own.cacheReadInputTokens])
  assert.deepEqual(p.models, ['claude-haiku-4-5-20251001'])
})

test('Codex: cumulative totals become per-turn usage; cached input is not counted twice', () => {
  const p = parseCodex(read('codex-rollout.jsonl'), 'rollout.jsonl')
  assert.equal(p.events.length, 3)
  // the mock API returned, per turn n: 100n input (30n of it cached), 7n output
  assert.deepEqual(
    p.events.map((e) => [e[2], e[3], e[5]]),
    [
      [70, 7, 30],
      [140, 14, 60],
      [210, 21, 90]
    ]
  )
  assert.deepEqual(sum(p), [420, 42, 0, 180])
  assert.deepEqual(p.models, ['mock-model'])
  assert.equal(new Set(p.events.map((e) => e[6])).size, 1, 'one session')
})

test('Gemini CLI: a message rewritten with its tool calls counts once', () => {
  const text = read('gemini-chat.jsonl')
  const p = parseGemini(text, 'session.jsonl')
  assert.equal(text.split('\n').filter((l) => l.includes('"tokens"')).length, 4, 'four lines, three model replies')
  assert.equal(p.events.length, 3)
  assert.deepEqual(sum(p), [15, 15, 0, 0])
  assert.deepEqual(p.models, ['gemini-3.1-pro-preview'])
})

test('broken lines and foreign files are skipped, not fatal', () => {
  const junk = '{"type":"assistant","message":{"usage":\n\u0000\nnot json "usage"\n{"type":"assistant","message":{"id":"m","model":"<synthetic>","usage":{"input_tokens":5}},"timestamp":"2026-01-01T00:00:00Z"}\n'
  assert.equal(parseClaude(junk, 'j.jsonl').events.length, 0)
  assert.equal(parseCodex(junk, 'j.jsonl').events.length, 0)
  assert.equal(parseGemini(junk, 'j.json').events.length, 0)
  assert.equal(parseGemini('{"tokens": [', 'j.json').events.length, 0)
})

// ---- growing logs: read on from where the last read stopped ----

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-usage-grow-'))
const PARSE = { claude: parseClaude, codex: parseCodex, gemini: parseGemini } as const
const FIXTURES = { claude: 'claude-session.jsonl', codex: 'codex-rollout.jsonl', gemini: 'gemini-chat.jsonl' } as const
const stat = (agent: keyof typeof PARSE, file: string) => {
  const st = fs.statSync(file)
  return { agent, file, mtime: st.mtimeMs, size: st.size }
}
const strip = (e: any) => ({ models: e.models, sessions: e.sessions, events: e.events })

for (const agent of ['claude', 'codex', 'gemini'] as const) {
  test(`${agent}: a log read as it grows, cut at any byte, adds up to the same as reading it whole`, async () => {
    const text = read(FIXTURES[agent])
    const file = path.join(scratch, `${agent}-grow.jsonl`)
    const whole = strip(PARSE[agent](text, file))
    assert.ok(whole.events.length > 0)
    const bytes = Buffer.from(text)
    // every line boundary, the middle of lines, and the middle of a multi-byte character
    const cuts = new Set<number>([1, 7])
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) [i, i + 1, i + 2].forEach((c) => cuts.add(c))
    for (let i = 13; i < bytes.length; i += 97) cuts.add(i)
    for (const cut of [...cuts].filter((c) => c < bytes.length)) {
      fs.writeFileSync(file, bytes.subarray(0, cut))
      const first = await readLog(stat(agent, file))
      fs.appendFileSync(file, bytes.subarray(cut))
      const next = await readLog(stat(agent, file), first)
      assert.deepEqual(strip(next), whole, `cut at byte ${cut}`)
      assert.equal(next.offset, bytes.length)
    }
    // and in three steps, each from the previous read
    fs.writeFileSync(file, '')
    let entry = await readLog(stat(agent, file))
    for (const part of [bytes.subarray(0, 900), bytes.subarray(900, 2000), bytes.subarray(2000)]) {
      fs.appendFileSync(file, part)
      entry = await readLog(stat(agent, file), entry)
    }
    assert.deepEqual(strip(entry), whole)
  })
}

test('a growing log is not read again from the start', async () => {
  const file = path.join(scratch, 'only-new.jsonl')
  const text = read('claude-session.jsonl')
  fs.writeFileSync(file, text)
  const first = await readLog(stat('claude', file))
  // an early line changed in place (outside what is fingerprinted) would be seen by a full read
  const mid = text.length - 400
  const changed = text.slice(0, mid).replaceAll('claude-haiku-4-5-20251001', 'claude-zzzzz-4-5-20251001') + text.slice(mid)
  assert.notEqual(changed, text)
  fs.writeFileSync(file, changed + '\n')
  const next = await readLog(stat('claude', file), first)
  assert.deepEqual(strip(next), strip(first), 'only the appended (empty) line was read')
  assert.notDeepEqual(strip(parseClaude(changed, file)), strip(first))
})

test('a log rewritten or cut shorter is read again from the start, never counted twice', async () => {
  const file = path.join(scratch, 'rewritten.jsonl')
  const text = read('codex-rollout.jsonl')
  fs.writeFileSync(file, text)
  const first = await readLog(stat('codex', file))
  // replaced by another session's log that is longer
  const other = read('codex-rollout.jsonl').replace(/mock-model/g, 'other-model') + '\n'
  fs.writeFileSync(file, other)
  assert.deepEqual(strip(await readLog(stat('codex', file), first)), strip(parseCodex(other, file)))
  // cut shorter
  const short = text.split('\n').slice(0, 3).join('\n') + '\n'
  fs.writeFileSync(file, short)
  assert.deepEqual(strip(await readLog(stat('codex', file), first)), strip(parseCodex(short, file)))
})

test('a line longer than a read chunk, and a log bigger than one, are read whole', async () => {
  const file = path.join(scratch, 'huge.jsonl')
  const lines = read('claude-session.jsonl').split('\n')
  // a 20 MB tool result in the middle (no usage in it), then the rest
  const big = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(20 * 1024 * 1024) }] } })
  const text = [...lines.slice(0, 3), big, ...lines.slice(3)].join('\n')
  fs.writeFileSync(file, text)
  const entry = await readLog(stat('claude', file))
  assert.deepEqual(strip(entry), strip(parseClaude(read('claude-session.jsonl'), file)))
  fs.rmSync(file)
})

test('a read that fails midway leaves the cached entry as it was', async () => {
  const file = path.join(scratch, 'vanishing.jsonl')
  fs.writeFileSync(file, read('claude-session.jsonl'))
  const first = await readLog(stat('claude', file))
  const before = JSON.stringify(first)
  fs.appendFileSync(file, read('claude-session.jsonl').replace(/msg_/g, 'msgB_'))
  const grown = stat('claude', file)
  await readLog(grown, first)
  assert.equal(JSON.stringify(first), before, 'reading on does not change the entry it started from')
  fs.rmSync(file)
  await assert.rejects(readLog(grown, first))
  assert.equal(JSON.stringify(first), before)
})

// ---- through the app: files on disk, resumed sessions, plan-limit windows ----

function put(rel: string, text: string) {
  const f = path.join(home, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
const HOUR = 3600_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const claudeLine = (id: string, msAgo: number, input: number, output: number) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), sessionId: 's-recent', requestId: `req_${id}`, message: { id, model: 'claude-sonnet-x', usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } } })

test('usage report: resumed sessions repeat history and are counted once; limit windows', async () => {
  // the recorded runs, moved well into the past so only the messages below fall in the limit windows
  const past = (t: string) => t.replace(/"timestamp": "\d{4}-\d\d-\d\dT/g, '"timestamp": "2024-01-15T')
  const claude = past(read('claude-session.jsonl'))
  put('.claude/projects/-demo/a.jsonl', claude)
  // a resumed session starts a new file that repeats the earlier messages
  put('.claude/projects/-demo/b.jsonl', claude + claudeLine('msg_resumed', 30 * 24 * HOUR, 10, 20) + '\n')
  // recent activity for the plan-limit estimates: m1 opens a 5-hour window that has expired, m2 opens the current one
  put('.claude/projects/-other/c.jsonl', [claudeLine('m1', 8 * HOUR, 100, 50), claudeLine('m2', 2 * HOUR, 200, 60), claudeLine('m3', HOUR, 300, 70)].join('\n') + '\n')
  put('.codex/sessions/2024/01/15/rollout.jsonl', past(read('codex-rollout.jsonl')))
  put('.gemini/tmp/demo/chats/session.jsonl', past(read('gemini-chat.jsonl')))
  put('.gemini/tmp/demo/chats/session-copy.jsonl', past(read('gemini-chat.jsonl')))

  register({ ipc: ipcMain as any, emit: () => {} } as any)
  const r: any = await ipcMain.invoke('usage:tokens', { force: true })
  const c = r.agents.claude
  assert.deepEqual(
    [c.lifetime.input, c.lifetime.output, c.lifetime.cacheCreate, c.lifetime.cacheRead],
    [18 + 10 + 600, 178 + 20 + 180, 4595, 57675 + 4 * 1000],
    'each message once, across files'
  )
  assert.equal(c.files, 3)
  assert.equal(r.agents.codex.lifetime.total, 420 + 42 + 180)
  assert.equal(r.agents.gemini.lifetime.total, 30, 'the same chat in two files counts once')

  const lim: any = await ipcMain.invoke('usage:limits', 'claude')
  assert.equal(lim.session.active, true)
  // every token the window moved, cache reads included: they are ~97% of what agent work reads, and a
  // "tokens used" figure without them is not a token count (each fixture line reads 1000 from cache)
  assert.equal(lim.session.tokens, 200 + 60 + 300 + 70 + 2 * 1000, 'the window opened 2 hours ago')
  assert.ok(Math.abs(lim.session.resetsAt - (Date.now() + 3 * HOUR)) < 60_000)
  assert.equal(lim.week.tokens, 100 + 50 + 200 + 60 + 300 + 70 + 3 * 1000, 'the week opened 8 hours ago; the message a month ago is in an expired one')
  const codex: any = await ipcMain.invoke('usage:limits', 'codex')
  assert.equal(codex.session.active, false, 'nothing recent')
})
