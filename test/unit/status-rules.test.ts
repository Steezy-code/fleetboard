import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectPrompt, hookStatus, normalizeLine, StatusTracker, ECHO_MS, STARTING_MS, STARTING_MAX_MS } from '../../src/main/status'
import type { ScreenView } from '../../src/main/screen'
import type { Prompt } from '../../src/shared/prompt'

/** A screen: TUI mode (cursor hidden) unless a cursor row is given. */
function view(text: string, opts: Partial<ScreenView> = {}): ScreenView {
  const lines = text.replace(/^\n/, '').split('\n')
  while (lines.length < 24) lines.push('')
  return { lines, cursorX: 0, cursorY: opts.cursorY ?? 0, alt: false, cursorHidden: opts.cursorY === undefined, ...opts }
}

describe('detectPrompt: TUI dialogs', () => {
  test('numbered menu with a selection cursor', () => {
    const p = detectPrompt(view(' Do you want to proceed?\n ❯ 1. Yes\n   2. No'))
    assert.equal(p?.reason, 'numbered-menu')
    assert.deepEqual(p?.lines, [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'])
  })

  test('a menu drawn inside a box (Gemini)', () => {
    const p = detectPrompt(view('╭──────────────────╮\n│ ● 1. Trust folder │\n│   2. Don\'t trust  │\n╰──────────────────╯'))
    assert.equal(p?.reason, 'numbered-menu')
  })

  test('unnumbered menu needs options lined up under the cursor', () => {
    assert.equal(detectPrompt(view('     Auto\n ❯ ✔ Dark mode\n     Light mode\n     Dark mode (ANSI)'))?.reason, 'cursor-menu')
    // a lone cursor line is not a menu
    assert.equal(detectPrompt(view(' ❯ Dark mode\n\n some text')), null)
  })

  test("a long message Codex echoes back ('› …' wrapped to the screen's width) is not a menu", () => {
    // what a Codex team worker showed after its brief (100 columns), from a real run
    const screen = [
      '',
      '  >_ OpenAI Codex (v0.163.0)',
      '     /tmp/fb-e2e-re2O43/fleetboard/worktrees/0a7dda2e2417/txt-bb25-ada',
      '',
      '› You are Ada, a worker on a Fleetboard team led by Lead. Do only the task you are given and edit',
      '  only the files you own. If you need something outside them, ask the lead with fleet_send. Work in',
      '  your current directory (your own git worktree). Do not commit or push; Fleetboard commits your',
      '  work when you report. When your done_when check passes, call fleet_report with status "done" and',
      '  a 3-6 line summary (what changed, files, how you verified). If you are stuck, call fleet_report',
      '  with status "blocked" and what you need. Task from Lead: Write a.txt You own: a.txt. Done when:',
      '  a.txt exists. When done, call fleet_report.',
      '',
      "• Ran printf 'Codex was here\\n' > a.txt",
      '  └ (no output)',
      '• Reported to the lead.',
      '  Worked for <1s • 9:37 AM',
      '',
      '› Ask Codex to do anything',
      '',
      '  Mock default · /tmp/fb-e2e-re2O43/fleetboard/worktrees/0a7dda2e2417/txt-bb25-ada',
      '  ? for shortcuts                                                         ⚠ 2 warnings · f2 to view'
    ].join('\n')
    assert.equal(detectPrompt(view(screen, { cols: 100 })), null)
    // a menu whose options are short still is one, also with a long first option
    const menu = '  Pick a model?\n› gpt-x (current) — the default model for most tasks, balanced for speed and depth of reasoning\n  gpt-x-mini — faster and cheaper\n  gpt-x-max — slowest, most thorough'
    assert.equal(detectPrompt(view(menu, { cols: 100 }))?.reason, 'cursor-menu')
  })

  test('a two-option menu counts under a question with nothing below it (Claude Code: make auto mode the default?)', () => {
    const dialog = ' Make auto mode your default permission mode?\n   Auto mode lets Claude handle permission prompts.\n   ❯ Yes, set auto mode as my default permission mode\n     No, keep manual mode'
    const p = detectPrompt(view(dialog))
    assert.equal(p?.reason, 'cursor-menu')
    assert.deepEqual(p?.options?.map((o) => o.label), ['Yes, set auto mode as my default permission mode', 'No, keep manual mode'])
    // two lined-up lines are not a menu without the question, or with more text below
    assert.equal(detectPrompt(view(' Notes\n   ❯ first point\n     second point')), null)
    assert.equal(detectPrompt(view(dialog + '\n some log line after it')), null)
  })

  test('hints', () => {
    assert.equal(detectPrompt(view(' Press any key to continue'))?.reason, 'press-key')
    assert.ok(detectPrompt(view(' Press Enter to continue…')))
    assert.equal(detectPrompt(view(' Enter to confirm · Esc to cancel'))?.reason, 'enter-to')
    assert.equal(detectPrompt(view(' (Use Enter to select)'))?.reason, 'enter-to')
    assert.equal(detectPrompt(view(' ↑/↓ to navigate'))?.reason, 'navigate')
    assert.equal(detectPrompt(view(' Allow this MCP server to run?'))?.reason, 'allow-question')
  })

  test('working footers are not questions', () => {
    assert.equal(detectPrompt(view('* Smooshing… (esc to interrupt)\n──────────\n❯ \n──────────\n  ⏸ manual mode on · esc to interrupt')), null)
  })

  test("Claude Code's idle input box, and what is typed into it, are not dialogs", () => {
    const screen = [
      '● Do you want to proceed?', // the agent's reply, above the box
      '  ❯ 1. Yes',
      '    2. No',
      '──────────────────────────',
      '❯ Do you want to proceed? (y/n)',
      '  ❯ 1. Yes',
      '    2. No',
      '──────────────────────────',
      '  ⏸ manual mode on · ? for shortcuts'
    ].join('\n')
    assert.equal(detectPrompt(view(screen)), null)
  })

  test('a dialog that replaced the input box is found even with conversation above it', () => {
    const screen = ['❯ Run the tests', '● Bash(npm test)', '──────────', ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n')
    assert.equal(detectPrompt(view(screen))?.reason, 'numbered-menu')
  })

  test('only the bottom of the screen is a dialog region', () => {
    const lines = [' Do you want to proceed?', ...Array.from({ length: 40 }, (_, i) => `log line ${i}`)]
    assert.equal(detectPrompt({ lines, cursorX: 0, cursorY: 0, alt: false, cursorHidden: true }), null)
  })

  test('empty screen', () => {
    assert.equal(detectPrompt(view('')), null)
    assert.equal(detectPrompt({ lines: [], cursorX: 0, cursorY: 0, alt: false, cursorHidden: true }), null)
  })
})

describe('detectPrompt: line mode (cursor visible)', () => {
  test('a question on the cursor row', () => {
    assert.equal(detectPrompt(view('$ ./install.sh\nInstall 3 packages? [Y/n] ', { cursorY: 1 }))?.reason, 'yes-no')
    assert.equal(detectPrompt(view('$ sudo ls\n[sudo] password for me: ', { cursorY: 1 }))?.reason, 'password')
    assert.equal(detectPrompt(view('Add file to the chat? (Y)es/(N)o/(A)ll [Yes]: ', { cursorY: 0 }))?.reason, 'yes-no-words')
  })

  test('the same text above the cursor is history', () => {
    assert.equal(detectPrompt(view('Install 3 packages? [Y/n] y\nDone.\n$ ', { cursorY: 2 })), null)
    assert.equal(detectPrompt(view('Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to confirm\n$ ', { cursorY: 4 })), null)
  })

  test('an empty cursor row asks nothing', () => {
    assert.equal(detectPrompt(view('Continue? [y/N]\n', { cursorY: 1 })), null)
  })

  test('the alternate screen counts as a TUI even with the cursor shown', () => {
    assert.equal(detectPrompt(view(' ❯ 1. Yes\n   2. No', { cursorY: 5, cursorHidden: false, alt: true }))?.reason, 'numbered-menu')
  })
})

test('normalizeLine strips frames and non-breaking spaces', () => {
  assert.equal(normalizeLine('│ ● 1. Trust │'), ' ● 1. Trust')
  assert.equal(normalizeLine('❯ Try "fix lint"   '), '❯ Try "fix lint"')
})

describe('hookStatus', () => {
  const cases: [string, any, string | null][] = [
    ['SessionStart', {}, 'idle'],
    ['UserPromptSubmit', {}, 'working'],
    ['PreToolUse', { tool_name: 'Bash' }, 'working'],
    ['PostToolUse', {}, 'working'],
    ['PermissionRequest', { tool_name: 'Bash' }, 'needs-you'],
    ['Stop', {}, 'idle'],
    ['SubagentStop', {}, null],
    ['SessionEnd', {}, 'done'],
    ['Notification', { notification_type: 'permission_prompt' }, 'needs-you'],
    ['Notification', { notification_type: 'elicitation_dialog' }, 'needs-you'],
    ['Notification', { notification_type: 'idle_prompt' }, 'idle'],
    ['Notification', { notification_type: 'auth_success' }, null],
    ['Notification', { message: 'Claude needs your permission to use Bash' }, 'needs-you'],
    ['Notification', { message: 'Claude is waiting for your input' }, 'idle'],
    ['Notification', { message: 'something else' }, null],
    ['Notification', null, null],
    ['SomethingNew', {}, null]
  ]
  for (const [event, payload, want] of cases) {
    test(`${event} ${JSON.stringify(payload)} → ${want}`, () => assert.equal(hookStatus(event, payload), want))
  }
})

describe('StatusTracker', () => {
  const ask: Prompt = { reason: 'numbered-menu', kind: 'menu', lines: [] }
  /** output chunks every `every` ms from `from` to `to` */
  const stream = (t: StatusTracker, from: number, to: number, every = 100) => {
    for (let at = from; at <= to; at += every) t.output(at)
  }

  test('starting, then idle; output while starting does not count as work', () => {
    const t = new StatusTracker(0)
    stream(t, 100, 1000)
    assert.equal(t.evaluate(1000, null), 'starting')
    assert.equal(t.evaluate(STARTING_MS + 2500, null), 'idle')
  })

  test('a hooked CLI is starting until its first hook, at most STARTING_MAX_MS', () => {
    const t = new StatusTracker(0, true)
    assert.equal(t.evaluate(STARTING_MS + 100, null), 'starting')
    assert.equal(t.evaluate(STARTING_MAX_MS + 100, null), 'idle')
    const u = new StatusTracker(0, true)
    u.hookEvent('SessionStart', {}, 5000)
    assert.equal(u.evaluate(5100, null), 'idle')
    assert.equal(u.ready, true)
  })

  test('sustained output is work; one blip is not', () => {
    const t = new StatusTracker(0)
    t.output(10_000)
    assert.equal(t.evaluate(10_100, null), 'idle')
    stream(t, 20_000, 21_000)
    assert.equal(t.evaluate(21_050, null), 'working')
    assert.equal(t.evaluate(23_100, null), 'idle', 'quiet for more than QUIET_MS')
  })

  test('a log line a second keeps a console working', () => {
    const t = new StatusTracker(0)
    stream(t, 10_000, 15_000, 1000)
    for (const at of [11_500, 12_500, 13_900, 15_500]) assert.equal(t.evaluate(at, null), 'working', `at ${at}`)
  })

  test('the echo of typing is not work', () => {
    const t = new StatusTracker(0)
    for (let at = 10_000; at < 12_000; at += 120) {
      t.input(at)
      t.output(at + 15)
    }
    assert.equal(t.evaluate(12_000, null), 'idle')
    assert.ok(ECHO_MS > 15)
  })

  test('a prompt on screen wins over activity and hooks', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('PreToolUse', {}, 5000)
    stream(t, 5000, 6000)
    assert.equal(t.evaluate(6000, ask), 'needs-you')
  })

  test('PermissionRequest holds needs-you until the user answers', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('PermissionRequest', {}, 5000)
    assert.equal(t.evaluate(5100, null), 'needs-you')
    assert.equal(t.evaluate(60_000, null), 'needs-you')
    t.input(60_500)
    assert.equal(t.evaluate(60_600, null), 'idle')
  })

  test('PermissionRequest releases when the CLI moves on by itself', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('PermissionRequest', {}, 5000)
    stream(t, 5100, 5900) // the dialog drawing itself
    assert.equal(t.evaluate(5950, null), 'needs-you')
    stream(t, 7000, 8000) // resolved elsewhere, the agent works on
    assert.equal(t.evaluate(8050, null), 'working')
  })

  test('after Stop, closing redraws are not work until the user types', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('Stop', {}, 10_000)
    stream(t, 10_010, 10_100, 30)
    t.output(11_300)
    for (const at of [10_200, 11_000, 11_400, 12_000]) assert.equal(t.evaluate(at, null), 'idle', `at ${at}`)
  })

  test('after Stop, a long stream is a turn the CLI started by itself', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('Stop', {}, 10_000)
    stream(t, 12_000, 14_000)
    assert.equal(t.evaluate(14_000, null), 'working')
  })

  test('a working hook bridges short gaps, then decays', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('PreToolUse', {}, 10_000)
    assert.equal(t.evaluate(12_000, null), 'working')
    assert.equal(t.evaluate(16_000, null), 'idle', 'an interrupted turn does not stay working forever')
  })

  test('SubagentStop after Stop leaves the console idle', () => {
    const t = new StatusTracker(0, true)
    t.hookEvent('Stop', {}, 10_000)
    t.hookEvent('SubagentStop', {}, 11_400)
    assert.equal(t.evaluate(11_500, null), 'idle')
  })

  test('paused and done', () => {
    const t = new StatusTracker(0, true)
    t.paused = true
    assert.equal(t.evaluate(10_000, ask), 'paused')
    t.paused = false
    t.hookEvent('SessionEnd', {}, 11_000)
    assert.equal(t.evaluate(11_100, null), 'done')
  })
})
