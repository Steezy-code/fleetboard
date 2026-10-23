// Turn a blocked agent's prompt (read from its screen by the main process) into plain buttons, for the
// Inbox on the board and the one on a phone (src/main/remote.ts).
import type { Prompt, PromptAnswer } from './prompt'

export interface ApprovalOption {
  answer: PromptAnswer
  label: string
  tone: 'allow' | 'always' | 'deny' | 'other'
}

export interface Approval {
  /** the question, in the agent's words */
  title: string
  /** what it wants to run or change, when the dialog shows it */
  detail?: string
  /** the shell command it asks to run, exactly as shown, when it is a shell command (commandOf) */
  command?: string
  options: ApprovalOption[]
}

const RULE = /[╌─━═]{6,}/
const PERMISSION = /\b(do you want|would you like|allow|approve|permission|proceed|trust)\b/i

function tone(label: string, permission: boolean): ApprovalOption['tone'] {
  const l = label.toLowerCase()
  if (/^(no|deny|reject|cancel|don.?t|exit|quit)\b/.test(l)) return 'deny'
  if (!permission) return 'other'
  if (/^always\b/.test(l)) return 'always'
  if (/^(yes|allow|approve)\b.*\b(always|don.?t ask|for this session|for the session|from this project|accept edits)\b/.test(l)) return 'always'
  if (/^(yes|allow|approve|proceed|trust|ok)\b/.test(l)) return 'allow'
  return 'other'
}

/** The key a CLI shows next to an option, "(y)", "(esc)", "(shift+tab)": meaningless on a button. */
const KEY_HINT = /\s*\((?:[a-z]|esc|enter|tab|shift\+tab|ctrl\+[a-z])\)\s*$/i

/** Short button text for the long option labels CLIs use. */
function shortLabel(raw: string, t: ApprovalOption['tone'], permission: boolean): string {
  const label = raw.replace(KEY_HINT, '')
  const l = label.toLowerCase()
  if (permission && t === 'allow' && /^yes(,? proceed)?\.?$/.test(l)) return 'Allow once'
  if (permission && t === 'deny' && /^no\.?$/.test(l)) return 'Deny'
  if (/^yes, i trust this folder$/.test(l)) return 'Trust folder'
  if (/^no, exit$/.test(l)) return 'No, close agent'
  if (/switch to accept edits/.test(l)) return 'Allow all edits this session'
  if (/always allow access to .* from this project/.test(l)) return 'Always allow (this project)'
  const again = /don.?t ask again for:?\s*(.+)$/i.exec(label)?.[1]?.replace(/^commands that start with\s+/i, '')
  if (again) {
    const what = again.replace(/ in \/.+$/, '')
    return `Always allow ${what.length > 44 ? what.slice(0, 43) + '…' : what}`
  }
  return label.length > 64 ? label.slice(0, 61) + '…' : label
}

/** Options an Inbox button can't sensibly answer: they change app-wide modes or need typing. */
const HIDDEN = /switch to auto mode|bypass permissions|^type something\.?$/i

/**
 * In a permission dialog, what it is about. Claude Code frames it with rules: a header ("Bash command",
 * "Create file" + path) between the dialog's top rule and the next, then the command or content.
 */
function detailOf(p: Prompt): string | undefined {
  const qAt = p.question ? p.lines.findIndex((l) => l.trim() === p.question) : -1
  if (qAt < 0) return undefined
  const above = p.lines.slice(0, qAt)
  const rules = above.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)
  if (rules.length < 2) return undefined
  const between = (a: number, b: number) =>
    above
      .slice(a + 1, b)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('Tip:'))
  // the last two rules, and the one before them when there is one: two is the minimum checked above
  const n = rules.length
  const prev = rules[n - 2]
  const last = rules[n - 1]
  if (prev === undefined || last === undefined) return undefined
  const third = n >= 3 ? rules[n - 3] : undefined
  const block = [...(third !== undefined ? between(third, prev) : []), ...between(prev, last)]
  return block.length && block.length <= 14 ? block.join('\n') : undefined
}

/**
 * Without rules (Codex): the dialog's own lines, from its first question to the menu, such as
 * "Would you like to run the following command?" / "Reason: …" / "$ touch notes.txt". Not the
 * conversation above it (lines the CLI marks as said: › • ●) and not key hints.
 */
function plainDetailOf(p: Prompt): string | undefined {
  const first = p.options?.[0]?.label
  const menuAt = first ? p.lines.findIndex((l) => l.includes(first)) : -1
  if (menuAt < 1) return undefined
  const above = p.lines.slice(Math.max(0, menuAt - 10), menuAt).map((l) => l.trim())
  const start = above.findIndex((l) => /\?\s*$/.test(l) && !/^[›•●❯>]/.test(l))
  if (start < 0) return undefined
  const block = above.slice(start).filter((l) => l && l !== p.question?.trim() && !/^(press enter|enter to confirm|esc to cancel)/i.test(l))
  return block.length ? block.join('\n') : undefined
}

const DASHED = /^╌{6,}$/

/**
 * The shell command a permission prompt asks to run, every line of it, exactly as the CLI shows it.
 * Null for anything else (a file edit, folder trust, a question) and whenever the command can't be
 * told apart with certainty: a team rule (teamRules.ts) matches on this string, so a command cut
 * short here would let a rule approve a longer one that merely starts the same way.
 */
export function commandOf(p: Prompt | null): string | null {
  if (!p || p.kind !== 'menu') return null
  const lines = p.lines.map((l) => l.trim())
  const join = (block: string[]) => {
    const cmd = block.filter(Boolean).join('\n').trim()
    return cmd || null
  }
  // Claude Code: a "Bash command" header, then the command between the next two dashed rules
  const bash = lines.lastIndexOf('Bash command')
  if (bash >= 0) {
    const dashes = lines.flatMap((l, i) => (i > bash && DASHED.test(l) ? [i] : []))
    const [a, b] = dashes
    return a !== undefined && b !== undefined ? join(lines.slice(a + 1, b)) : null
  }
  // Codex: "$ <command>" under its question, running on (when it wraps) to the menu
  const codex = lines.findLastIndex((l) => l === 'Would you like to run the following command?')
  if (codex >= 0) {
    const first = p.options?.[0]?.label
    const menu = first ? lines.findIndex((l, i) => i > codex && l.includes(first)) : -1
    const dollar = lines.findIndex((l, i) => i > codex && l.startsWith('$ '))
    if (menu < 0 || dollar < 0 || dollar > menu) return null
    return join([lines[dollar]!.slice(2), ...lines.slice(dollar + 1, menu)])
  }
  // Gemini: the command in a frame of its own, right above "Allow execution of [Shell]?"
  const gemini = lines.findLastIndex((l) => l === 'Allow execution of [Shell]?')
  if (gemini >= 1 && lines[gemini - 1]!.startsWith('╰')) {
    const top = lines.findLastIndex((l, i) => i < gemini - 1 && l.startsWith('╭'))
    if (top < 0) return null
    return join(lines.slice(top + 1, gemini - 1).map((l) => l.replace(/^│\s?/, '').replace(/\s*│$/, '')))
  }
  return null
}

/** A plain word on what a command does, when it is clear from the command. Null when unsure. */
export function commandNote(cmd: string | undefined): string | null {
  if (!cmd) return null
  const c = cmd.trim().replace(/^(sudo\s+)?/, '')
  if (/\brm\s+-[a-z]*r|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force))|\bdrop\s+(table|database)\b/i.test(c)) return 'Deletes or overwrites things'
  if (/\bgit\s+push\b|\bnpm\s+publish\b|\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)\b/i.test(c)) return 'Sends something off this machine'
  if (/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b|^pip3?\s+install\b|^cargo\s+add\b/i.test(c)) return 'Installs packages'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|^(npx\s+)?(vitest|jest|pytest|playwright\s+test)\b|^(cargo|go)\s+test\b/i.test(c)) return 'Runs your tests'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|lint|build|check)\b|^(npx\s+)?tsc\b/i.test(c)) return 'Runs a check or build'
  if (/^(ls|cat|head|tail|wc|grep|rg|find|tree|pwd|which)\b|^git\s+(status|diff|log|show|branch)\b/i.test(c)) return 'Only reads'
  return null
}

/**
 * Whether one yes may stand for a whole team's identical requests. Never for what deletes, overwrites
 * or sends something off this machine, nor anything run as root: each of those deserves its own look.
 */
export function teamRuleAllowed(cmd: string): boolean {
  const note = commandNote(cmd)
  if (note === 'Deletes or overwrites things' || note === 'Sends something off this machine') return false
  return !/\b(sudo|doas|runas|curl|wget|ssh|scp|rsync|nc)\b/i.test(cmd)
}

export function approvalFor(p: Prompt | null): Approval | null {
  if (!p) return null
  if (p.kind === 'menu' && p.options?.length) {
    const permission = PERMISSION.test(p.question ?? '') || p.options.some((o) => /trust/i.test(o.label))
    const options = p.options
      .filter((o) => !HIDDEN.test(o.label))
      .map((o): ApprovalOption => {
        const t = tone(o.label, permission)
        return { answer: { option: o.label }, label: shortLabel(o.label, t, permission), tone: t }
      })
    if (!options.length) return null
    const rank = { allow: 0, always: 1, other: 2, deny: 3 }
    if (permission) options.sort((a, b) => rank[a.tone] - rank[b.tone])
    const command = permission ? commandOf(p) : null
    return { title: p.question ?? 'Choose an option', detail: detailOf(p) ?? plainDetailOf(p), ...(command ? { command } : {}), options }
  }
  if (p.kind === 'yes-no') {
    return {
      title: p.question ?? p.lines[p.lines.length - 1] ?? '',
      options: [
        { answer: { yes: true }, label: 'Yes', tone: 'allow' },
        { answer: { yes: false }, label: 'No', tone: 'deny' }
      ]
    }
  }
  if (p.kind === 'enter') {
    return { title: p.lines.slice(-2).join('\n'), options: [{ answer: { enter: true }, label: 'Continue', tone: 'allow' }] }
  }
  return null
}
