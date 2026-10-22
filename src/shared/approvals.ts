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
    return { title: p.question ?? 'Choose an option', detail: detailOf(p) ?? plainDetailOf(p), options }
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
