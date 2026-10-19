import type { ConsoleStatus } from '@shared/types'
import type { AnswerResult, Prompt, PromptAnswer, PromptOption } from '@shared/prompt'
import type { ScreenView } from './screen'

export type { Prompt, PromptOption }

// Console status from what the terminal shows, how its output flows and what the CLI's own hooks
// say. Pure and clock-injected, so recorded sessions (test/fixtures/casts) can be replayed through it.
// Precedence: paused > ended > a prompt on screen > a "needs you" hook > activity > hooks > idle.

// ------------------------------------------------------------------ prompts on screen

/** A prompt's region: how many rows from the bottom of the screen a dialog can occupy. */
const REGION_ROWS = 26

const RULE = /^[\s─━═╌┄┈╍┉╭╮╰╯┌┐└┘├┤┬┴┼-]*[─━═╌┄┈╍┉]{6,}[\s─━═╌┄┈╍┉╭╮╰╯┌┐└┘├┤┬┴┼-]*$/

/** Remove box borders (│ … │) and non-breaking spaces so dialogs drawn in a frame read as plain lines. */
export function normalizeLine(line: string): string {
  return line
    .replace(/ /g, ' ')
    .replace(/^(\s*)[│┃║]/, '$1')
    .replace(/[│┃║]\s*$/, '')
    .replace(/\s+$/, '')
}

// Text that only appears while a CLI waits for a decision. Matched in the prompt region.
const HINTS: [string, RegExp][] = [
  ['enter-to', /\b(enter|return) to (confirm|select|continue|save|submit|proceed|choose)\b/i],
  ['press-key', /\bpress (enter|return|any key)\b/i],
  ['navigate', /(↑\/↓|↑↓|arrow keys|up\/down)( keys)? to (navigate|select|move|choose)/i],
  ['esc-cancel', /\besc(ape)? to cancel\b/i],
  ['do-you-want', /\bdo you want to (proceed|make this edit|make these edits|create|run|allow|overwrite|delete|continue|apply|use|fetch|write|edit)\b/i],
  ['would-you-like', /\bwould you like to (proceed|run|allow|continue|apply|make|create|overwrite)\b/i],
  ['trust-folder', /\btrust (this folder|the files in this folder|this (project|workspace|directory))\b/i],
  ['allow-question', /^.*\b(allow|approve|deny|permit)\b[^\n]*\?\s*$/im],
  ['requires-approval', /\brequires? (your )?(approval|permission|confirmation)\b/i]
]

// Asked on the line the cursor sits on (shell programs, installers, aider): only there, because the
// same words scrolled up in the output are history, not a question.
const CURSOR_PROMPTS: [string, RegExp][] = [
  ['yes-no', /[[(]\s*(y\/n|y\/N|Y\/n|yes\/no|Yes\/No)\s*[\])]/],
  ['yes-no-words', /\(Y\)es\/\(N\)o/],
  ['default-answer', /\[(Yes|No|Y|N)\]:\s*$/],
  ['password', /\b(password|passphrase|passcode|pin)( for [^:]+)?:\s*$/i],
  ['continue-q', /\b(continue|proceed|overwrite)\?\s*$/i]
]

const SELECTOR = '❯›>▶►▸➜→●◉◆'
/** glyphs CLIs also use for their input box (menu-only glyphs like ● never start one) */
const INPUT_GLYPH = /^\s*[❯›>]/
const SELECTOR_START = new RegExp(`^\\s*[${SELECTOR}]`)
/** "❯ 1. Yes", "  2. No", "● 1. Trust folder": groups are the selector (if any) and the number */
const NUMBERED_ITEM = new RegExp(`^(\\s*)([${SELECTOR}])?\\s*(?:[✔✓]\\s*)?(\\d{1,2})[.)]\\s+(\\S.*)$`)
const CURSOR_ITEM = new RegExp(`^(\\s*)[${SELECTOR}]\\s+(?:[✔✓]\\s+)?(\\S.*)$`)
/** hints that say the screen is a menu to pick from */
const MENU_HINT = /\b(enter|return) to (confirm|select|choose)\b|↑\/↓|↑↓|arrow keys|esc(ape)? to cancel/i

const indentOf = (l: string) => l.length - l.trimStart().length
const blankish = (l: string) => !l.trim() || RULE.test(l)
const stripMark = (t: string) => t.replace(/^[✔✓]\s+/, '').trim()

/**
 * An input box: a prompt glyph on a line framed by a rule right above it (Claude Code, Gemini).
 * Text typed there can look like a menu ("❯ 1. fix the bug"), so it never counts as one.
 */
function isInputBox(lines: string[], i: number) {
  if (!INPUT_GLYPH.test(lines[i])) return false
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].trim()) continue
    return RULE.test(lines[j])
  }
  return false
}

/**
 * The last row of the last input box on screen (its closing rule, or the prompt row when it has none).
 * What is typed into the box is not a dialog, and rows below it are the CLI's footer: a dialog
 * replaces the box, so while one shows there is no box under it.
 */
function lastInputBoxEnd(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!SELECTOR_START.test(lines[i]) || !isInputBox(lines, i)) continue
    for (let j = i + 1; j < lines.length; j++) if (RULE.test(lines[j])) return j
    return i
  }
  return -1
}

interface Menu {
  reason: 'numbered-menu' | 'cursor-menu'
  options: PromptOption[]
  /** row of the first option */
  top: number
}

/**
 * A numbered menu around the selected row `i`: options share the column of their number; rows
 * between them that are blank, rules or indented deeper belong to the option above (its wrapped
 * text or its description).
 */
function numberedMenu(lines: string[], i: number, cols: number): Menu | null {
  const first = NUMBERED_ITEM.exec(lines[i])!
  const col = first[0].indexOf(first[3], first[1].length)
  const isOption = (l: string) => {
    const m = NUMBERED_ITEM.exec(l)
    return m && m[0].indexOf(m[3], m[1].length) === col ? m : null
  }
  const belongs = (l: string) => blankish(l) || indentOf(l) > col
  let top = i
  for (let j = i - 1; j >= 0; j--) {
    if (isOption(lines[j])) top = j
    else if (!belongs(lines[j])) break
  }
  const options: PromptOption[] = []
  let wrapped = false
  for (let j = top; j < lines.length; j++) {
    const l = lines[j]
    const m = isOption(l)
    if (m) {
      if (Number(m[3]) !== options.length + 1) break
      options.push({ label: m[4].trim(), selected: !!m[2] })
      // a label that reaches the right edge continues on the next row
      wrapped = l.length >= cols - 12
      continue
    }
    if (!belongs(l)) break
    if (blankish(l)) {
      wrapped = false
      continue
    }
    const o = options[options.length - 1]
    if (wrapped) o.label += ' ' + l.trim()
    else o.detail = o.detail ? `${o.detail} ${l.trim()}` : l.trim()
    wrapped = wrapped && l.length >= cols - 12
  }
  if (options.length < 2 || options.filter((o) => o.selected).length !== 1) return null
  return { reason: 'numbered-menu', options, top }
}

/** An unnumbered menu: the options line up with the text after the cursor. */
function cursorMenu(lines: string[], i: number, minSiblings: number): Menu | null {
  const m = CURSOR_ITEM.exec(lines[i])!
  const col = lines[i].length - m[2].length
  // tree connectors (Claude Code's "⎿ result" under a "● Tool(...)" line) are output, not options
  const sibling = (l: string) => !!l.trim() && indentOf(l) === col && !/^\s*[⎿└├│┃]/.test(l)
  let top = i
  let bottom = i
  while (top > 0 && sibling(lines[top - 1])) top--
  while (bottom < lines.length - 1 && sibling(lines[bottom + 1])) bottom++
  if (bottom - top < minSiblings) return null
  const options: PromptOption[] = []
  for (let j = top; j <= bottom; j++) options.push({ label: stripMark(j === i ? m[2] : lines[j]), selected: j === i })
  return { reason: 'cursor-menu', options, top }
}

/**
 * The dialog's menu. Dialogs sit at the bottom, under the conversation, so the lowest menu wins, and
 * a numbered menu (unmistakable) wins over an unnumbered one (conversation can line up like one).
 */
function findMenu(lines: string[], cols: number, hinted: boolean): Menu | null {
  const candidates = (fn: (i: number) => Menu | null) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!SELECTOR_START.test(lines[i]) || isInputBox(lines, i)) continue
      const menu = fn(i)
      if (menu) return menu
    }
    return null
  }
  return (
    candidates((i) => (NUMBERED_ITEM.exec(lines[i])?.[2] ? numberedMenu(lines, i, cols) : null)) ??
    candidates((i) => (CURSOR_ITEM.test(lines[i]) && !NUMBERED_ITEM.test(lines[i]) ? cursorMenu(lines, i, hinted ? 1 : 2) : null))
  )
}

/** The question above a menu: a row ending in "?" close above it, else the nearest text row. */
function questionAbove(lines: string[], top: number): string | undefined {
  let nearest: string | undefined
  for (let j = top - 1; j >= 0 && j >= top - 10; j--) {
    const t = lines[j].trim()
    if (!t || RULE.test(lines[j])) continue
    if (/\?$/.test(t)) return t
    nearest ??= t
  }
  return nearest
}

const answerKind = (reason: string): Prompt['kind'] =>
  reason === 'password' ? 'input' : /^(yes-no|yes-no-words|default-answer|continue-q)$/.test(reason) ? 'yes-no' : /^(enter-to|press-key)$/.test(reason) ? 'enter' : 'input'

export function detectPrompt(view: ScreenView): Prompt | null {
  const raw = view.lines.map(normalizeLine)
  const cols = view.cols ?? Math.max(80, ...raw.map((l) => l.length))
  let end = raw.length
  while (end > 0 && !raw[end - 1].trim()) end--
  if (!end) return null
  let start = Math.max(0, end - REGION_ROWS)
  const box = lastInputBoxEnd(raw.slice(0, end))
  if (box >= 0) start = Math.max(start, box + 1)
  const region = raw.slice(start, end)
  const lines = region.filter((l) => l.trim())

  // A TUI (cursor hidden, or on the alternate screen) draws its dialogs anywhere near the bottom.
  // A line-mode program (a shell, aider, an installer) asks where its cursor waits: text above the
  // cursor is output that already scrolled past, even when it reads like a question.
  if (view.cursorHidden || view.alt) {
    const text = region.join('\n')
    const menu = findMenu(region, cols, MENU_HINT.test(text))
    if (menu) return { reason: menu.reason, kind: 'menu', lines, question: questionAbove(region, menu.top), options: menu.options }
    for (const [reason, re] of HINTS) if (re.test(text)) return { reason, kind: answerKind(reason), lines }
    const last = raw[end - 1]
    for (const [reason, re] of CURSOR_PROMPTS) if (re.test(last)) return { reason, kind: answerKind(reason), lines: [last.trim()], question: last.trim() }
    return null
  }
  const row = raw[view.cursorY] ?? ''
  if (!row.trim()) return null
  for (const [reason, re] of [...CURSOR_PROMPTS, ...HINTS]) if (re.test(row)) return { reason, kind: answerKind(reason), lines: [row.trim()], question: row.trim() }
  return null
}

/**
 * The keystrokes that give `answer` to the prompt on screen now, or why it can't: the prompt is gone
 * (answered in the terminal meanwhile) or changed (another question, or that option is no longer
 * offered). Menus are answered by moving the cursor and pressing Enter, which every menu understands,
 * numbered or not. `appCursor`: the program asked for application cursor keys (ESC O A instead of ESC [ A).
 */
export function answerKeys(prompt: Prompt | null, answer: PromptAnswer, appCursor = false): string[] | Extract<AnswerResult, { ok: false }> {
  if (!prompt) return { ok: false, reason: 'gone' }
  if ('option' in answer) {
    const options = prompt.kind === 'menu' ? (prompt.options ?? []) : []
    const target = options.findIndex((o) => o.label === answer.option)
    if (target < 0) return { ok: false, reason: 'changed' }
    const at = Math.max(0, options.findIndex((o) => o.selected))
    const step = target > at ? (appCursor ? '\x1bOB' : '\x1b[B') : appCursor ? '\x1bOA' : '\x1b[A'
    return [...Array<string>(Math.abs(target - at)).fill(step), '\r']
  }
  if ('yes' in answer) return prompt.kind === 'yes-no' ? [answer.yes ? 'y' : 'n', '\r'] : { ok: false, reason: 'changed' }
  return prompt.kind === 'enter' ? ['\r'] : { ok: false, reason: 'changed' }
}

// ------------------------------------------------------------------ hooks

export type HookStatus = ConsoleStatus | null

/**
 * What a Claude Code hook event says about the console. null: nothing (SubagentStop fires after
 * the main turn ended, for background helpers, and must not flip an idle console back to working).
 */
export function hookStatus(event: string, payload: any): HookStatus {
  switch (event) {
    case 'SessionStart':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PreCompact':
      return 'working'
    case 'PermissionRequest':
      return 'needs-you'
    case 'Stop':
      return 'idle'
    case 'SessionEnd':
      return 'done'
    case 'Notification': {
      const type = String(payload?.notification_type ?? '')
      if (/permission|elicitation/.test(type)) return 'needs-you'
      if (/idle/.test(type)) return 'idle'
      if (type) return null
      // older versions only send a message
      const msg = String(payload?.message ?? '').toLowerCase()
      if (/waiting for your input|idle/.test(msg)) return 'idle'
      if (/permission|approv|needs your|confirm/.test(msg)) return 'needs-you'
      return null
    }
    default:
      return null
  }
}

// ------------------------------------------------------------------ tracker

/** Output this soon after a keystroke is the terminal echoing it, not the agent working. */
export const ECHO_MS = 250
/** Window in which output counts as activity. */
export const ACTIVE_WINDOW_MS = 3000
/** This long without output and a console is no longer working (a log line a second keeps it working). */
export const QUIET_MS = 2000
/** Chunks in the activity window that mean a hooked CLI started a turn by itself after stopping. */
export const SUSTAINED_CHUNKS = 12
/** A CLI is "starting" this long after launch unless it says otherwise. */
export const STARTING_MS = 4000
/** Without any hook, a hooked CLI stops counting as starting after this long. */
export const STARTING_MAX_MS = 15000

export class StatusTracker {
  status: ConsoleStatus = 'starting'
  /** the CLI finished starting (Claude Code: SessionStart hook) */
  ready = false
  paused = false
  lastOutput: number
  lastInput = 0
  private outputs: number[] = []
  private hook: { status: ConsoleStatus; at: number } | null = null
  private sawHook = false

  constructor(
    readonly startedAt: number,
    /** the CLI reports through hooks (Claude Code with the hook server running) */
    readonly hooked = false
  ) {
    this.lastOutput = startedAt
  }

  output(now: number) {
    this.lastOutput = now
    if (now - this.lastInput < ECHO_MS) return
    this.outputs.push(now)
    if (this.outputs.length > 64) this.outputs.splice(0, this.outputs.length - 64)
  }

  input(now: number) {
    this.lastInput = now
  }

  hookEvent(event: string, payload: any, now: number) {
    this.sawHook = true
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') this.ready = true
    const s = hookStatus(event, payload)
    if (s) this.hook = { status: s, at: now }
  }

  /** Output that shows the CLI busy: several chunks spread over time, all after `since`. */
  private activeSince(now: number, since: number) {
    const from = Math.max(now - ACTIVE_WINDOW_MS, since)
    const recent = this.outputs.filter((t) => t > from)
    if (!recent.length || now - recent[recent.length - 1] > QUIET_MS) return false
    if (recent.length >= 6) return true
    return recent.length >= 2 && recent[recent.length - 1] - recent[0] >= 300
  }

  evaluate(now: number, prompt: Prompt | null): ConsoleStatus {
    const next = this.decide(now, prompt)
    this.status = next
    return next
  }

  private decide(now: number, prompt: Prompt | null): ConsoleStatus {
    if (this.paused) return 'paused'
    const hook = this.hook
    if (hook?.status === 'done') return 'done'
    if (prompt) return 'needs-you'
    // a permission hook holds until the user answers or the CLI visibly moves on without them
    if (hook?.status === 'needs-you' && this.lastInput <= hook.at && !this.activeSince(now, hook.at + 1000)) return 'needs-you'
    // launch: a hooked CLI is starting until its first hook (bounded, in case hooks never arrive)
    const age = now - this.startedAt
    if (!this.sawHook && age < (this.hooked ? STARTING_MAX_MS : STARTING_MS)) return 'starting'
    // After the CLI said it stopped, only output after that counts. Until the user types again, its
    // closing redraws are not work: it takes a sustained stream (a spinner) to count as a new turn.
    const idleAt = hook?.status === 'idle' ? hook.at : 0
    if (idleAt && this.lastInput <= idleAt) {
      if (this.outputs.filter((t) => t > Math.max(idleAt, now - ACTIVE_WINDOW_MS)).length >= SUSTAINED_CHUNKS && now - this.lastOutput < 1000) return 'working'
    } else if (this.activeSince(now, idleAt)) return 'working'
    if (hook?.status === 'working' && now - Math.max(hook.at, this.lastOutput) < 5000) return 'working'
    return 'idle'
  }
}
