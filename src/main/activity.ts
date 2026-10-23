// What a console is doing, from what its terminal shows: Claude Code marks each tool call with a
// bullet ("● Update(src/main/pty.ts)"), so the newest one in the current turn is its current step.
// No model is asked — one call per worker on a timer would spend the user's tokens to label a tile —
// and a CLI whose output does not parse gets null, which the tile shows as plain "working": a wrong
// verb is worse than no verb.
//
// It reads TermScreen.text(), which keeps the glyphs; Oracle's cleanTail (helm/context.ts) strips
// exactly these, so this cannot run on that.

const RULE = /^\s*[─━═]{6,}\s*$/
/** a bullet at the left edge: Claude Code's mark for a tool call or a reply ("⏺" on macOS) */
const BULLET = /^[●⏺]\s+(.*\S)\s*$/
const PROMPT = /^❯ /
const MCP = /^(\S+) - (\S+) \(MCP\)(?:\((.*)\))?$/
const TOOL = /^([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?)\((.*)\)$/

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const code = (s: string) => `\`${clip(s.trim())}\``
/** `pattern: "x", path: "src"` → x; a bare argument as it is */
const firstValue = (args: string) => /^\w+:\s*"((?:[^"\\]|\\.)*)"/.exec(args)?.[1] ?? args.replace(/^"(.*)"$/, '$1')

const FLEET: Record<string, string | ((args: string) => string)> = {
  fleet_wait: 'waiting for the team',
  fleet_plan: 'planning',
  fleet_update_task: 'updating the plan',
  fleet_spawn_worker: 'starting a worker',
  fleet_spawn_reviewer: 'starting a reviewer',
  fleet_merge: (a) => {
    const who = /worker:\s*"([^"]+)"/.exec(a)?.[1]
    return who ? `merging ${clip(who, 30)}’s work` : 'merging'
  },
  fleet_report: 'reporting to the lead',
  fleet_send: 'sending a message',
  fleet_ask_user: 'asking you',
  fleet_status: 'checking the team',
  fleet_dismiss: 'dismissing a member',
  fleet_finish: 'handing the work over'
}

function verb(tool: string, args: string): string {
  switch (tool) {
    case 'Read':
      return `reading ${code(args)}`
    case 'Edit':
    case 'Update':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `editing ${code(args)}`
    case 'Write':
    case 'Create':
      return `writing ${code(args)}`
    case 'Bash':
      return `running ${code(args)}`
    case 'Grep':
    case 'Search':
      return `searching for ${code(firstValue(args))}`
    case 'Glob':
      return `finding ${code(firstValue(args))}`
    case 'List':
    case 'LS':
      return `listing ${code(args)}`
    case 'Fetch':
    case 'WebFetch':
      return `fetching ${code(firstValue(args))}`
    case 'Web Search':
    case 'WebSearch':
      return 'searching the web'
    case 'Task':
    case 'Agent':
      return `delegating: ${clip(args.trim(), 50)}`
    case 'BashOutput':
      return 'watching a command'
    default:
      return `using ${tool}`
  }
}

/** The newest bullet of the turn on screen, or null when this turn has drawn none yet. */
function currentBullet(lines: string[]): string | null {
  // An input box is a prompt row with a rule right above it; any other prompt row at the left edge is
  // a prompt the user sent, echoed into the conversation, and the current turn starts under it.
  const ruleAbove = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (lines[j]!.trim()) return RULE.test(lines[j]!)
    return false
  }
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT.test(lines[i]!) && !ruleAbove(i)) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let bullet: string | null = null
  // the turn ends at the first rule under it: the input box, or a dialog drawn over it
  for (let i = start + 1; i < lines.length && !RULE.test(lines[i]!); i++) {
    const m = BULLET.exec(lines[i]!)
    if (m) bullet = m[1]!
  }
  return bullet
}

/** Claude Code's current step, as a few words for the tile. */
export function claudeActivity(text: string): string | null {
  const bullet = currentBullet(text.split('\n'))
  if (!bullet) return null
  if (/^Update Todos$/.test(bullet)) return 'updating its todo list'
  const mcp = MCP.exec(bullet)
  if (mcp) {
    const [, server = '', tool = '', args = ''] = mcp
    const fleet = server === 'fleet' ? FLEET[tool] : undefined
    if (fleet) return typeof fleet === 'string' ? fleet : fleet(args)
    return `using ${clip(server, 20)} ${clip(tool, 30)}`
  }
  const call = TOOL.exec(bullet)
  // anything else is prose: the reply after the last tool, so no tool is running
  return call ? verb(call[1]!, call[2]!) : null
}

/** What a console is doing, or null when its CLI's output does not say (the tile then reads "working"). */
export function activityOf(agentId: string, text: string): string | null {
  return agentId === 'claude' ? claudeActivity(text) : null
}
