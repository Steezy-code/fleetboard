import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { ConsoleStatus, PtyInfo, PtySpawnRequest, Settings } from '@shared/types'
import { agentById } from '@shared/agents'
import { loginEnv, shellPath, which } from './env'
import { claudeHookArgs, hookEnv } from './hooks'
import { profileEnv } from './profiles'
import { fleetLaunch } from './fleet'
import { TermScreen, type ScreenView } from './screen'
import { StatusTracker, answerKeys, detectPrompt, type Prompt } from './status'
import type { AnswerResult, PromptAnswer } from '@shared/prompt'

/** Pause between keystrokes of an answer: TUIs read one key per input event. */
const KEY_GAP_MS = 70

const MAX_BUFFER = 400_000

interface Session {
  id: string
  agentId: string
  proc: pty.IPty
  /** raw output, replayed into the board's terminal when its node mounts again */
  buffer: string
  /** what the terminal shows (status, Inbox, handoffs read this, not the raw stream) */
  screen: TermScreen
  tracker: StatusTracker
  startedAt: number
  /** the CLI turned on bracketed paste (ESC[?2004h) */
  bracketed: boolean
}

const TERMINAL_REPLY = /^(?:\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\d*n|\x1b\[[IO]|\x1bP[\s\S]*?\x1b\\|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/
// OSC/DCS strings end at the first BEL or ESC\ (non-greedy: shells emit many, e.g. OSC 3008 per command)
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b[()][0-9A-B]|\x1b[=>78DEHMc]/g
// TUIs often draw spaces as cursor-forward moves and lines as absolute positioning.
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(200, Number(n || 1))))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(ANSI, '')
    .replace(/\r/g, '')

type ExitListener = (id: string, code: number | undefined, appClosing: boolean) => void

export class PtyManager {
  private sessions = new Map<string, Session>()
  private exitListeners = new Set<ExitListener>()
  /** the app is quitting: consoles exit because of that, not on their own */
  private disposing = false
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
    if (req.command) {
      // a console started for one command (dev server, watcher); drop into a shell when it ends
      file = shellPath()
      args = ['-lc', `${req.command}; exec ${shellPath()} -l`]
    } else if (!agent || agent.id === 'shell') {
      file = shellPath()
      args = ['-l']
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

    const startedAt = Date.now()
    const s: Session = {
      id: req.id,
      agentId: req.agentId,
      proc,
      buffer: '',
      screen: new TermScreen(Math.max(20, req.cols | 0), Math.max(5, req.rows | 0)),
      // Claude Code reports through hooks when the hook server is up (claudeHookArgs is non-empty)
      tracker: new StatusTracker(startedAt, agent?.id === 'claude' && !req.command && claudeHookArgs(req.id).length > 0),
      startedAt,
      bracketed: false
    }
    this.sessions.set(req.id, s)

    proc.onData((data) => {
      s.buffer += data
      if (data.includes('\x1b[?2004')) s.bracketed = data.lastIndexOf('\x1b[?2004h') > data.lastIndexOf('\x1b[?2004l')
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER)
      s.screen.write(data)
      s.tracker.output(Date.now())
      this.emit('pty:data', req.id, data)
    })
    proc.onExit(({ exitCode }) => {
      // a respawn under the same id may already have replaced this session
      if (this.sessions.get(req.id) === s) this.sessions.delete(req.id)
      s.screen.dispose()
      this.emit('pty:exit', req.id, exitCode)
      this.emit('pty:status', req.id, 'exited')
      for (const l of this.exitListeners) {
        try {
          l(req.id, exitCode, this.disposing)
        } catch (e) {
          console.error('exit listener failed', e)
        }
      }
    })
    return this.info(s)
  }

  private info(s: Session): PtyInfo {
    return { id: s.id, pid: s.proc.pid, agentId: s.agentId, status: s.tracker.status, startedAt: s.startedAt }
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id)
    if (!s) return
    // xterm answers terminal queries (device attributes, cursor position, colors, focus) through the
    // same channel; those replies are not the user typing and must not clear "needs you".
    if (!TERMINAL_REPLY.test(data)) s.tracker.input(Date.now())
    s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id)
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0))
        s.screen.resize(Math.max(20, cols | 0), Math.max(5, rows | 0))
      } catch {
        /* process may be exiting */
      }
    }
  }

  kill(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.tracker.paused) this.signal(s, 'SIGCONT')
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
    if (!s || s.tracker.paused) return
    this.signal(s, 'SIGSTOP')
    s.tracker.paused = true
    this.evaluate(s)
  }

  resume(id: string) {
    const s = this.sessions.get(id)
    if (!s || !s.tracker.paused) return
    this.signal(s, 'SIGCONT')
    s.tracker.paused = false
    this.evaluate(s)
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
    if (!s || s.tracker.paused || s.tracker.status !== 'idle') return false
    const quiet = Date.now() - s.tracker.lastOutput
    // wait for the screen to settle: input typed mid-redraw right after startup can get stuck
    if (s.tracker.hooked) return s.tracker.ready && quiet > 1200
    return Date.now() - s.startedAt > 6000 && quiet > 2000
  }

  status(id: string): ConsoleStatus | null {
    return this.sessions.get(id)?.tracker.status ?? null
  }

  buffer(id: string) {
    return this.sessions.get(id)?.buffer ?? null
  }

  /** Plain text of what the terminal showed, scrollback included: the last N characters. */
  tail(id: string, chars = 12000) {
    return this.sessions.get(id)?.screen.text(chars) ?? ''
  }

  /**
   * Answer the prompt on screen. Re-read from the live screen first, so a stale Inbox card never
   * types into a console whose question was already answered in its terminal.
   */
  async answer(id: string, answer: PromptAnswer): Promise<AnswerResult> {
    const s = this.sessions.get(id)
    if (!s) return { ok: false, reason: 'not-live' }
    await s.screen.flush()
    const keys = answerKeys(detectPrompt(s.screen.view()), answer, s.screen.appCursorKeys)
    if (!Array.isArray(keys)) return keys
    for (const [i, k] of keys.entries()) {
      if (i) await new Promise((r) => setTimeout(r, KEY_GAP_MS))
      if (!this.sessions.has(id)) return { ok: false, reason: 'not-live' }
      this.write(id, k)
    }
    return { ok: true }
  }

  /** The visible screen and the prompt on it, if the CLI is asking something. */
  screen(id: string): { view: ScreenView; prompt: Prompt | null } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const view = s.screen.view()
    return { view, prompt: detectPrompt(view) }
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s))
  }

  /** An event from Claude Code's hooks (see hooks.ts). */
  hook(id: string, event: string, payload: unknown) {
    const s = this.sessions.get(id)
    if (!s) return
    s.tracker.hookEvent(event, payload, Date.now())
    this.evaluate(s)
  }

  private evaluate(s: Session) {
    const prev = s.tracker.status
    const next = s.tracker.evaluate(Date.now(), detectPrompt(s.screen.view()))
    if (next !== prev) this.emit('pty:status', s.id, next)
  }

  private refreshStatuses() {
    for (const s of this.sessions.values()) this.evaluate(s)
  }

  /** Called when a console's process ends, with its exit code. */
  onExit(listener: ExitListener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  dispose() {
    this.disposing = true
    clearInterval(this.tick)
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  get size() {
    return this.sessions.size
  }
}
