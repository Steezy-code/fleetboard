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
 * The row in `p.lines` where the menu starts: the last row reading "1. <first option>". Everything
 * about the dialog is read upward from here, never from the top of the region: the region also holds
 * up to a screenful of transcript above the dialog, and an agent's reply can print any text there,
 * including text laid out like a dialog.
 */
function menuAt(p: Prompt): number {
  const first = p.options?.[0]?.label
  if (p.kind !== 'menu' || !first) return -1
  const ROW = /^\s*[❯›>▶►▸➜→●◉◆]?\s*(?:[✔✓]\s*)?1[.)]\s+(\S.*)$/
  return p.lines.findLastIndex((l) => {
    const m = ROW.exec(l)
    return !!m && first.startsWith(m[1]!.trim())
  })
}

// A Claude Code dialog's own rules are drawn from column 0 across the screen. Its content is padded,
// and transcript rows are indented under "● " and "⎿", so neither starts at column 0: that is what
// tells the dialog's frame from rule-like text in a reply or inside a command.
const DASH_RULE = /^╌{20,}$/
const TOP_RULE = /^─{20,}$/

/**
 * A Claude Code permission dialog, read upward from its menu: the question, the closing ╌ rule, the
 * body (the command or the file), the opening ╌ rule, the header ("Bash command", "Create file" …)
 * and the top ─ rule. Null unless that whole shape is there and every row inside it is padded.
 * `whole` is false when the region starts below the top rule (a dialog taller than the region).
 */
function claudeDialog(p: Prompt): { header: string[]; body: string[]; whole: boolean } | null {
  const top = menuAt(p)
  const L = p.lines
  if (top < 3 || L[top - 1]!.trim() !== p.question || !DASH_RULE.test(L[top - 2]!)) return null
  const close = top - 2
  const open = L.findLastIndex((l, i) => i < close && DASH_RULE.test(l))
  if (open < 0) return null
  const head = L.findLastIndex((l, i) => i < open && TOP_RULE.test(l))
  const body = L.slice(open + 1, close)
  const header = L.slice(head + 1, open)
  if (![...header, ...body].every((l) => /^\s/.test(l))) return null
  return { header: header.map((l) => l.trim()), body: body.map((l) => l.trim()), whole: head >= 0 }
}

/** In a permission dialog, what it is about: Claude Code's header and body, read from the dialog itself. */
function detailOf(p: Prompt): string | undefined {
  const d = claudeDialog(p)
  if (!d) return undefined
  const block = [...(d.whole ? d.header : []), ...d.body].filter((l) => l && !l.startsWith('Tip:'))
  return block.length ? block.join('\n') : undefined
}

/**
 * Without rules (Codex): the dialog's own lines, from its last question above the menu down to it,
 * such as "Would you like to run the following command?" / "Reason: …" / "$ touch notes.txt". Not the
 * conversation above it (lines the CLI marks as said: › • ●) and not key hints.
 */
function plainDetailOf(p: Prompt): string | undefined {
  const menu = menuAt(p)
  if (menu < 1) return undefined
  const above = p.lines.slice(Math.max(0, menu - 10), menu).map((l) => l.trim())
  // the dialog's own question when it has one ("Would you like to …"); its Reason line can end in "?" too
  const own = above.findLastIndex((l) => l.startsWith('Would you like to '))
  const start = own >= 0 ? own : above.findIndex((l) => /\?\s*$/.test(l) && !/^[›•●❯>]/.test(l))
  if (start < 0) return undefined
  const block = above.slice(start).filter((l) => l && l !== p.question?.trim() && !/^(press enter|enter to confirm|esc to cancel)/i.test(l))
  return block.length ? block.join('\n') : undefined
}

const join = (block: string[]) => block.filter(Boolean).join('\n').trim() || null

/**
 * The shell command a permission prompt asks to run, every line of it, exactly as the CLI shows it.
 * Null for anything else (a file edit, folder trust, a question) and whenever the dialog is not
 * unmistakably one asking to run a command: a team rule (teamRules.ts) matches on this string, so a
 * command read short, or read from text above the dialog, would let a rule approve something else.
 */
export function commandOf(p: Prompt | null): string | null {
  if (!p || p.kind !== 'menu') return null
  const top = menuAt(p)
  if (top < 1) return null
  const L = p.lines.map((l) => l.trim())
  // Claude Code: the whole dialog, top rule included, headed exactly "Bash command"
  const d = claudeDialog(p)
  if (d) return d.whole && d.header[0] === 'Bash command' ? join(d.body) : null
  // Codex: its question, then exactly one "$ " row, then the command's own rows down to the menu
  const q = L.findLastIndex((l, i) => i < top && l === 'Would you like to run the following command?')
  if (q >= 0) {
    const block = L.slice(q + 1, top)
    const dollars = block.flatMap((l, i) => (l.startsWith('$ ') ? [i] : []))
    if (dollars.length !== 1 || block.some((l) => l.startsWith('Would you like to '))) return null
    const at = dollars[0]!
    return join([block[at]!.slice(2), ...block.slice(at + 1)])
  }
  // Gemini: the question right above the menu, the command in its own frame right above that
  if (L[top - 1] === 'Allow execution of [Shell]?' && L[top - 2]?.startsWith('╰')) {
    const frame = L.findLastIndex((l, i) => i < top - 2 && l.startsWith('╭'))
    if (frame < 0) return null
    return join(L.slice(frame + 1, top - 2).map((l) => l.replace(/^│\s?/, '').replace(/\s*│$/, '')))
  }
  return null
}

/** A plain word on what a command does, when it is clear from the command. Null when unsure. */
export function commandNote(cmd: string | undefined): string | null {
  if (!cmd) return null
  const c = cmd.trim().replace(/^(sudo\s+)?/, '')
  if (/\brm\s+-[a-z]*r|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force))|\bdrop\s+(table|database)\b/i.test(c)) return 'Deletes or overwrites things'
  if (/\bgit\s+push\b|\bnpm\s+publish\b|\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)\b/i.test(c)) return 'Sends something off this machine'
  // the rest describe one command: "npm test && …" is not just "Runs your tests"
  if (/[;&|`\n]|\$\(/.test(c)) return null
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
    return { title: p.question ?? 'Choose an option', detail: detailOf(p) ?? plainDetailOf(p) ?? command ?? undefined, ...(command ? { command } : {}), options }
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
