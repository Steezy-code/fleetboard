import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { ConsoleStatus, PtyInfo, PtySpawnRequest, Settings } from '@shared/types'
import { agentById } from '@shared/agents'
import { loginEnv, shellPath, which } from './env'
import { claudeHookArgs, hookEnv } from './hooks'
import { profileEnv } from './profiles'
import { fleetLaunch } from './fleet'

const MAX_BUFFER = 400_000
const WORKING_WINDOW_MS = 2500

// Text that means the agent is blocked on the human. Matched against the tail of the screen.
const NEEDS_YOU = [
  /do you want to (proceed|make this edit|create|run|allow)/i,
  /\b(allow|approve|deny)\b.*\?/i,
  /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/,
  /press enter to (continue|confirm)/i,
  /waiting for (your )?(input|approval|confirmation)/i,
  /❯\s*1\.\s*yes/i,
  /requires? (your )?(approval|permission)/i,
  /trust (this|the files in this) folder/i,
  /enter to confirm/i,
  /\(esc to cancel\)|esc to cancel/i
]

interface Session {
  id: string
  agentId: string
  proc: pty.IPty
  buffer: string
  /** bytes of output ever received, and the count at the last keystroke sent to the CLI */
  total: number
  inputMark: number
  lastOutput: number
  lastInput: number
  status: ConsoleStatus
  /** status reported by the CLI's own hooks wins over heuristics for a while */
  hookStatus?: { status: ConsoleStatus; at: number }
  startedAt: number
  paused: boolean
  /** the CLI reported it finished starting (Claude Code SessionStart hook) */
  ready: boolean
  /** the CLI turned on bracketed paste (ESC[?2004h) */
  bracketed: boolean
}

const TERMINAL_REPLY = /^(?:\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\d*n|\x1b\[[IO]|\x1bP[\s\S]*?\x1b\\|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78DEHMc]/g
// TUIs often draw spaces as cursor-forward moves and lines as absolute positioning.
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(200, Number(n || 1))))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(ANSI, '')
    .replace(/\r/g, '')

export class PtyManager {
  private sessions = new Map<string, Session>()
  private tick: NodeJS.Timeout
  constructor(
    private wc: () => WebContents | null,
    private settings: () => Settings
  ) {
    this.tick = setInterval(() => this.refreshStatuses(), 700)
  }

  private emit(channel: string, ...args: unknown[]) {
    try {
      const wc = this.wc()
      if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
    } catch {
      // window closing: drop the event
    }
  }

  async spawn(req: PtySpawnRequest): Promise<PtyInfo> {
    const existing = this.sessions.get(req.id)
    if (existing) return this.info(existing)

    const settings = this.settings()
    const agent = agentById(req.agentId, settings.customAgents)
    const env = { ...(await loginEnv()), ...hookEnv(req.id), ...profileEnv(req.agentId, req.profileId) }
    env.FB_CONSOLE_ID = req.id

    let file: string
    let args: string[] = []
    if (!agent || agent.id === 'shell') {
      file = shellPath()
      args = ['-l']
    } else if (req.command) {
      file = shellPath()
      args = ['-lc', req.command]
    } else {
      file = (await which(agent.bin)) ?? agent.bin
      args = [...(agent.args ?? [])]
      if (req.resume && agent.resumeArgs) args.push(...agent.resumeArgs)
      const yolo = (req.autoApprove ?? settings.autoApprove) && agent.yoloArgs
      if (yolo) args.push(...agent.yoloArgs!)
      else if (req.acceptEdits && agent.editsArgs && !fleetLaunch(req)) args.push(...agent.editsArgs)
      if (agent.id === 'claude') args.push(...claudeHookArgs(req.id))
      // team consoles: MCP connection to the fleet, role prompt and role permissions
      const fleet = fleetLaunch(req)
      if (fleet) {
        args.push(...fleet.args)
        Object.assign(env, fleet.env)
      }
      if (req.extraArgs?.length) args.push(...req.extraArgs)
    }

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(20, req.cols | 0),
      rows: Math.max(5, req.rows | 0),
      cwd: req.cwd,
      env
    })

    const s: Session = {
      id: req.id,
      agentId: req.agentId,
      proc,
      buffer: '',
      lastOutput: Date.now(),
      lastInput: 0,
      total: 0,
      inputMark: 0,
      status: 'starting',
      startedAt: Date.now(),
      paused: false,
      ready: false,
      bracketed: false
    }
    this.sessions.set(req.id, s)

    proc.onData((data) => {
      s.buffer += data
      s.total += data.length
      if (data.includes('\x1b[?2004')) s.bracketed = data.lastIndexOf('\x1b[?2004h') > data.lastIndexOf('\x1b[?2004l')
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER)
      s.lastOutput = Date.now()
      this.emit('pty:data', req.id, data)
    })
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(req.id)
      this.emit('pty:exit', req.id, exitCode)
      this.emit('pty:status', req.id, 'exited')
    })
    return this.info(s)
  }

  private info(s: Session): PtyInfo {
    return { id: s.id, pid: s.proc.pid, agentId: s.agentId, status: s.status, startedAt: s.startedAt }
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id)
    if (!s) return
    // xterm answers terminal queries (device attributes, cursor position, colors, focus) through the
    // same channel; those replies are not the user typing and must not clear "needs you".
    if (!TERMINAL_REPLY.test(data)) {
      s.lastInput = Date.now()
      s.inputMark = s.total
    }
    s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id)
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0))
      } catch {
        /* process may be exiting */
      }
    }
  }

  kill(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.paused) this.signal(s, 'SIGCONT')
    try {
      s.proc.kill('SIGHUP')
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (this.sessions.has(id)) {
        try {
          process.kill(-s.proc.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }, 2500)
  }

  private signal(s: Session, sig: NodeJS.Signals) {
    try {
      process.kill(-s.proc.pid, sig) // whole process group: the CLI and its children
    } catch {
      try {
        process.kill(s.proc.pid, sig)
      } catch {
        /* gone */
      }
    }
  }

  pause(id: string) {
    const s = this.sessions.get(id)
    if (!s || s.paused) return
    this.signal(s, 'SIGSTOP')
    s.paused = true
    this.setStatus(s, 'paused')
  }

  resume(id: string) {
    const s = this.sessions.get(id)
    if (!s || !s.paused) return
    this.signal(s, 'SIGCONT')
    s.paused = false
    s.lastOutput = Date.now()
    this.setStatus(s, 'working')
  }

  /**
   * Type text as one paste (bracketed when the CLI asked for it) and optionally submit it.
   * Without the paste markers a TUI guesses where a fast burst of text ends, and the Enter that
   * follows can end up inside the paste as a newline instead of submitting it.
   */
  paste(id: string, text: string, submit = true) {
    const s = this.sessions.get(id)
    if (!s) return
    const clean = text.replace(/\r?\n/g, ' ').replace(/\x1b/g, '')
    this.write(id, s.bracketed ? `\x1b[200~${clean}\x1b[201~` : clean)
    if (submit) setTimeout(() => this.write(id, '\r'), s.bracketed ? 150 : 350)
  }

  /**
   * Safe to type a message into this console: idle, and the CLI is past its startup screens.
   * Claude Code says so through its SessionStart hook; other CLIs get a quiet period after launch.
   */
  readyForInput(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.paused || s.status !== 'idle') return false
    // wait for the screen to settle: input typed mid-redraw right after startup can get stuck
    if (s.agentId === 'claude') return s.ready && Date.now() - s.lastOutput > 1200
    return Date.now() - s.startedAt > 6000 && Date.now() - s.lastOutput > 2000
  }

  status(id: string): ConsoleStatus | null {
    return this.sessions.get(id)?.status ?? null
  }

  buffer(id: string) {
    return this.sessions.get(id)?.buffer ?? null
  }

  /** Plain text of the last N characters, for handoffs and loop goal checks. */
  tail(id: string, chars = 12000) {
    const b = this.sessions.get(id)?.buffer
    return b ? stripAnsi(b.slice(-chars * 3)).slice(-chars) : ''
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s))
  }

  /** Status pushed by Claude Code hooks (see hooks.ts). */
  hook(id: string, status: ConsoleStatus, event?: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') s.ready = true
    s.hookStatus = { status, at: Date.now() }
    this.setStatus(s, status)
  }

  private setStatus(s: Session, status: ConsoleStatus) {
    if (s.status === status) return
    s.status = status
    this.emit('pty:status', s.id, status)
  }

  private refreshStatuses() {
    const now = Date.now()
    for (const s of this.sessions.values()) {
      if (s.paused) continue
      // Only output since the last keystroke counts: once you answer a prompt, its text no longer
      // means the agent is blocked, even while it is still in the recent scrollback.
      const fresh = Math.min(s.total - s.inputMark, s.buffer.length, 6000)
      const screen = fresh > 0 ? stripAnsi(s.buffer.slice(-fresh)).slice(-1600) : ''
      const blocked = NEEDS_YOU.some((re) => re.test(screen))
      // A hook report stays authoritative until new output arrives after it.
      if (s.hookStatus && s.lastOutput - s.hookStatus.at < 1500 && s.hookStatus.status !== 'working') {
        if (blocked && s.hookStatus.status !== 'needs-you') this.setStatus(s, 'needs-you')
        continue
      }
      // Output that is only an echo of the user's typing is not "working".
      const echo = s.lastOutput - s.lastInput < 250
      let next: ConsoleStatus
      if (blocked) next = 'needs-you'
      else if (now - s.lastOutput < WORKING_WINDOW_MS && !echo) next = 'working'
      else if (now - s.startedAt < 4000) next = 'starting'
      else next = 'idle'
      this.setStatus(s, next)
    }
  }

  dispose() {
    clearInterval(this.tick)
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  get size() {
    return this.sessions.size
  }
}
