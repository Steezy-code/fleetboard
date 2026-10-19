// Turn a blocked agent's terminal prompt into plain buttons.

export interface ApprovalOption {
  key: string
  label: string
  tone: 'allow' | 'always' | 'deny' | 'other'
}

export interface Approval {
  /** what the agent wants to do, in its own words */
  what: string
  options: ApprovalOption[]
}

const RULE = /[╌─━═]{6,}/

export function parseApproval(tail: string): Approval | null {
  const text = tail.replace(/\r/g, '')
  // Claude Code's folder-trust screen is an arrow-key menu without numbers
  const trustAt = text.lastIndexOf('Yes, I trust this folder')
  if (trustAt >= 0 && trustAt > text.length - 600) {
    const folder = /Accessing workspace:\s*\n?\s*(\S[^\n]*)/.exec(text.slice(-1500))?.[1]?.trim()
    return {
      what: `Trust this folder${folder ? `: ${folder}` : ''}? The agent can read, edit and run files there.`,
      options: [
        { key: 'trust', label: 'Trust folder', tone: 'allow' },
        { key: 'exit', label: 'No, close agent', tone: 'deny' }
      ]
    }
  }
  // numbered menus (Claude Code, Codex, Gemini all use them)
  const q = Math.max(text.lastIndexOf('Do you want'), text.lastIndexOf('Would you like'), text.lastIndexOf('Allow'), text.lastIndexOf('trust'))
  const menuStart = q >= 0 ? q : Math.max(0, text.length - 900)
  const menu = text.slice(menuStart)
  const opts: ApprovalOption[] = []
  for (const m of menu.matchAll(/^[ \t>❯›]*([1-9])[.)]\s+(.+?)\s*$/gm)) {
    if (opts.some((o) => o.key === m[1])) continue
    const raw = m[2].replace(/\s+/g, ' ').trim()
    const low = raw.toLowerCase()
    let tone: ApprovalOption['tone'] = 'other'
    let label = raw
    if (/^(no|deny|reject|cancel)\b/.test(low) || /^no,/.test(low)) {
      tone = 'deny'
      label = 'Deny'
    } else if (/don.t ask again|always|for this session|for the session/.test(low)) {
      tone = 'always'
      const what = /(?:for|again for):?\s*(.+)$/i.exec(raw)?.[1]
      label = what ? `Always allow ${what.replace(/ in \/.+$/, '').slice(0, 42)}` : 'Allow for session'
    } else if (/auto mode|bypass/.test(low)) {
      tone = 'other'
      label = 'Switch to auto mode'
    } else if (/^yes\b/.test(low) || /trust/.test(low) || /^allow\b/.test(low) || /proceed/.test(low)) {
      tone = 'allow'
      label = /trust/.test(low) ? 'Trust folder' : 'Allow once'
    }
    opts.push({ key: m[1], label, tone })
  }
  if (!opts.length) {
    if (/\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/.test(text.slice(-400)))
      return {
        what: lastLines(text.slice(-400), 2),
        options: [
          { key: 'y', label: 'Yes', tone: 'allow' },
          { key: 'n', label: 'No', tone: 'deny' }
        ]
      }
    return null
  }
  // the request itself sits between the last two rules before the question
  const before = text.slice(0, menuStart)
  const parts = before.split(RULE)
  let what = parts.length >= 3 ? parts[parts.length - 2] : lastLines(before, 3)
  what = what
    .split('\n')
    .map((l) => l.replace(/^[\s│]+/, '').trim())
    .filter((l) => l && !/^(Bash command|Tip:|This command requires approval)/.test(l))
    .join('\n')
  if (!what) what = lastLines(before, 2)
  // menus usually put Deny last; hide "switch to auto mode" options (an app-wide decision, not a per-prompt one)
  return { what: what.slice(0, 400), options: opts.filter((o) => o.label !== 'Switch to auto mode').sort(order) }
}

const rank = { allow: 0, always: 1, other: 2, deny: 3 }
const order = (a: ApprovalOption, b: ApprovalOption) => rank[a.tone] - rank[b.tone]

function lastLines(t: string, n: number) {
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !RULE.test(l))
    .slice(-n)
    .join('\n')
}
