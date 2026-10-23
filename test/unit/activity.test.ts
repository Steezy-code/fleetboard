// What a console is doing, read off its screen: Claude Code's tool-call lines, replayed from real
// recordings (test/fixtures/casts) through the same screen model the app uses. A wrong verb is worse
// than none, so most of these are about when the parser must say nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityOf } from '../../src/main/activity'
import { loadCast, replay, screenAt } from '../support/casts'

const atMark = async (file: string, mark: string) => {
  const { marks } = await replay(loadCast(file))
  const m = marks.find((x) => x.mark === mark)
  assert.ok(m, `no mark "${mark}" in ${file}`)
  return m.text
}

test('a command waiting for permission is the command being run', async () => {
  assert.equal(activityOf('claude', await atMark('claude-session.cast', 'needs-you: bash permission')), 'running `touch made-by-bash.txt`')
})

test('a file waiting to be written is the file being written', async () => {
  assert.equal(activityOf('claude', await atMark('claude-session.cast', 'needs-you: edit permission')), 'writing `notes.txt`')
})

test('a command still running is what the console is doing', async () => {
  const cast = loadCast('claude-session.cast')
  const done = cast.events.find((e) => e.kind === 'h' && e.data[0] === 'PostToolUse' && /sleep 7/.test(JSON.stringify(e.data[1])))
  assert.ok(done, 'the sleep 7 run is in the recording')
  assert.equal(activityOf('claude', await screenAt(cast, done.t - 2000)), 'running `sleep 7 && echo finished`')
})

// Review Focus 1
test('a turn that has not reached a tool yet says nothing, whatever the turn before it did', async () => {
  assert.equal(activityOf('claude', await atMark('claude-session.cast', 'working: thinking')), null)
  const cast = loadCast('claude-session.cast')
  // the sleep turn has just been submitted: the tool lines on screen belong to the turns before it
  const asked = cast.events.find((e) => e.kind === 'h' && e.data[0] === 'UserPromptSubmit' && /sleep 7/.test(JSON.stringify(e.data[1])))
  assert.ok(asked)
  assert.equal(activityOf('claude', await screenAt(cast, asked.t + 300)), null)
})

// Review Focus 1
test('a reply after the tool line means the tool is over', async () => {
  for (const mark of ['idle: after bash', 'idle: after edit', 'idle: after question']) assert.equal(activityOf('claude', await atMark('claude-session.cast', mark)), null, mark)
})

// Review Focus 2
test('text that only looks like a tool line is not one', async () => {
  const { marks } = await replay(loadCast('claude-adversarial.cast'))
  for (const m of marks) assert.equal(activityOf('claude', m.text), null, m.mark)
  for (const file of ['codex-session.cast', 'gemini-session.cast', 'shell-session.cast']) {
    const cast = loadCast(file)
    const end = cast.events[cast.events.length - 1]?.t ?? 0
    assert.equal(activityOf('claude', await screenAt(cast, end)), null, file)
  }
})

test('a typed prompt shaped like a tool call is the user typing, not the agent working', () => {
  const screen = ['❯ fix it', '', '● Sure.', '', '─'.repeat(40), '❯ ● Bash(rm -rf /)', '─'.repeat(40)].join('\n')
  assert.equal(activityOf('claude', screen), null)
})

test('only Claude Code is parsed; any other CLI is plain "working"', async () => {
  const text = await atMark('claude-session.cast', 'needs-you: bash permission')
  for (const agent of ['codex', 'gemini', 'shell', 'aider']) assert.equal(activityOf(agent, text), null, agent)
})

const turn = (...lines: string[]) => ['❯ do the thing', '', ...lines, '', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n')

test('each tool reads as what it does', () => {
  const cases: [string, string][] = [
    ['● Update(src/main/pty.ts)', 'editing `src/main/pty.ts`'],
    ['⏺ Edit(src/main/pty.ts)', 'editing `src/main/pty.ts`'],
    ['● Read(src/shared/fleet.ts)', 'reading `src/shared/fleet.ts`'],
    ['● Write(notes.txt)', 'writing `notes.txt`'],
    ['● Search(pattern: "stalled", path: "src")', 'searching for `stalled`'],
    ['● Grep(stalled)', 'searching for `stalled`'],
    ['● Glob(src/**/*.ts)', 'finding `src/**/*.ts`'],
    ['● Fetch(https://example.com/docs)', 'fetching `https://example.com/docs`'],
    ['● Web Search("electron pty windows")', 'searching the web'],
    ['● Task(Find the status tracker)', 'delegating: Find the status tracker'],
    ['● Update Todos', 'updating its todo list'],
    ['● fleet - fleet_wait (MCP)(timeout_seconds: 170)', 'waiting for the team'],
    ['● fleet - fleet_wait (MCP)', 'waiting for the team'],
    ['● fleet - fleet_merge (MCP)(worker: "Ada")', 'merging Ada’s work'],
    ['● fleet - fleet_report (MCP)(status: "done", summary: "x")', 'reporting to the lead'],
    ['● github - create_issue (MCP)(title: "x")', 'using github create_issue'],
    ['● Frobnicate(x)', 'using Frobnicate']
  ]
  for (const [line, want] of cases) assert.equal(activityOf('claude', turn(line, '  ⎿  …')), want, line)
})

test('a long argument is clipped, not dropped', () => {
  const got = activityOf('claude', turn(`● Bash(${'x'.repeat(300)})`)) ?? ''
  assert.match(got, /^running `x+…`$/)
  assert.ok(got.length < 90, got)
})

test('a tool line with a prose bullet under it is over; a tool line under a prose bullet is current', () => {
  assert.equal(activityOf('claude', turn('● Read(a.ts)', '  ⎿  Read 4 lines', '● The file is short.')), null)
  assert.equal(activityOf('claude', turn('● I will look at the file.', '● Read(a.ts)')), 'reading `a.ts`')
})
