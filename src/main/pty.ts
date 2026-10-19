import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { ConsoleStatus, PtyInfo, PtySpawnRequest, Settings } from '@shared/types'
import { agentById } from '@shared/agents'
import { loginEnv, shellPath, which } from './env'
import { findCodexSession, newSessionId, sessionState, validSessionId } from './sessions'
import { claudeHookArgs, hookEnv } from './hooks'
import { profileEnv } from './profiles'
import { fleetLaunch, isTeamConsole } from './fleet'
import { TermScreen, type ScreenView } from './screen'
import { StatusTracker, TERMINAL_REPLY, answerKeys, detectPrompt, type Prompt } from './status'
import type { AnswerResult, PromptAnswer } from '@shared/prompt'
import { RunRecord } from './orphans'

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
  /** the conversation the CLI runs under, when known (AgentDef.session, or Claude's SessionStart hook) */
  sessionId?: string
  /** a CLI that picks its own id (Codex): where to look for it after a turn */
  discover?: { since: number; cwd: string; env: Record<string, string | undefined>; tries: number; lastTry: number }
  /** when the CLI last printed something */
  outputAt: number
}

export { stripAnsi } from '@shared/ansi'

type ExitListener = (id: string, code: number | undefined, appClosing: boolean) => void
type SpawnListener = (req: PtySpawnRequest) => void

export class PtyManager {
  private sessions = new Map<string, Session>()
  private exitListeners = new Set<ExitListener>()
  private spawnListeners = new Set<SpawnListener>()
  /** the app is quitting: consoles exit because of that, not on their own */
  private disposing = false
  private tick: NodeJS.Timeout
  /** the consoles running, on disk: the next launch ends what a crash of this one leaves running */
  private record = new RunRecord()
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
    let sessionId: string | undefined
    let notice = ''
    let lost = false
    if (req.command) {
      // a console started for one command (dev server, watcher); drop into a shell when it ends
      file = shellPath()
      args = ['-lc', `${req.command}; exec ${shellPath()} -l`]
    } else if (!agent || agent.id === 'shell') {
      file = shellPath()
      args = ['-l']
    } else {
      const found = await which(agent.bin)
      // say what is wrong and how to fix it, rather than "execvp(3) failed: No such file or directory"
      if (!found) throw new Error(`${agent.name} is not installed: "${agent.bin}" was not found on your PATH.${agent.install ? ` Install it with: ${agent.install}` : agent.homepage ? ` See ${agent.homepage}` : ''}`)
      file = found
      args = [...(agent.args ?? [])]
      if (agent.session) {
        // this console's own conversation: resume it if the CLI saved it, else start it under its id
        const known = validSessionId(req.sessionId) ? req.sessionId : undefined
        const state = known ? sessionState(agent.id, known, env, req.cwd) : 'free'
        if (req.resume && known && state === 'resumable') {
          sessionId = known
          args.push(...agent.session.resume(known))
        } else if (req.resume && !known && agent.resumeArgs) {
          // a console saved before conversations had ids: the CLI picks (Claude's hook reports which)
          args.push(...agent.resumeArgs)
        } else if (agent.session.start) {
          // nothing said yet: start again under the same id, unless the CLI already holds it
          sessionId = req.resume && known && state === 'free' ? known : newSessionId()
          args.push(...agent.session.start(sessionId))
        }
        if (req.resume && known && state !== 'resumable') notice = `\x1b[2mNo saved conversation to pick up: starting a new one.\x1b[0m\r\n`
        if (req.resume && known && state === 'lost') lost = true
        // else a new conversation whose id the CLI picks: found after its first turn
      } else if (req.resume && agent.resumeArgs) args.push(...agent.resumeArgs)
      const yolo = (req.autoApprove ?? settings.autoApprove) && agent.yoloArgs
      if (yolo) args.push(...agent.yoloArgs!)
      else if (req.acceptEdits && agent.editsArgs && !isTeamConsole(req.id)) args.push(...agent.editsArgs)
      if (agent.id === 'claude') args.push(...claudeHookArgs(req.id))
      // team consoles: MCP connection to the fleet, role prompt and role permissions
      const fleet = fleetLaunch(req, env)
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
      bracketed: false,
      sessionId,
      discover:
        agent?.session && !agent.session.start && !sessionId && !req.command
          ? { since: startedAt, cwd: req.cwd, env: { HOME: env.HOME, CODEX_HOME: env.CODEX_HOME }, tries: 0, lastTry: startedAt }
          : undefined,
      outputAt: startedAt
    }
    this.sessions.set(req.id, s)
    this.record.add(req.id, proc.pid)
    if (notice) {
      s.buffer += notice
      this.emit('pty:data', req.id, notice)
    }
    if (lost) this.emit('pty:lostSession', req.id)
    // '' forgets the conversation a console had: it was started fresh, its new id is not known yet
    if (agent?.session && !req.command) this.emit('pty:session', req.id, sessionId ?? '')
    for (const l of this.spawnListeners) {
      try {
        l(req)
      } catch (e) {
        console.error('spawn listener failed', e)
      }
    }

    proc.onData((data) => {
      s.buffer += data
      if (data.includes('\x1b[?2004')) s.bracketed = data.lastIndexOf('\x1b[?2004h') > data.lastIndexOf('\x1b[?2004l')
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER)
      s.screen.write(data)
      s.outputAt = Date.now()
      s.tracker.output(s.outputAt)
      this.emit('pty:data', req.id, data)
    })
    proc.onExit(({ exitCode }) => {
      // a respawn under the same id may already have replaced this session
      if (this.sessions.get(req.id) === s) this.sessions.delete(req.id)
      this.record.remove(req.id, proc.pid)
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
    return { id: s.id, pid: s.proc.pid, agentId: s.agentId, status: s.tracker.status, startedAt: s.startedAt, sessionId: s.sessionId }
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
   * A message from the board (a command, the Orchestrator, a loop, a handoff). When the console is
   * asking a question, typing would answer it (Enter picks the highlighted option, often "Yes"), so the
   * message is held until the question is answered and the console is ready.
   */
  send(id: string, text: string, submit = true) {
    const s = this.sessions.get(id)
    if (!s) return
    if (!detectPrompt(s.screen.view())) return this.paste(id, text, submit)
    this.emit('pty:held', id)
    if (submit) void this.deliver(id, text)
    else void this.whenNoQuestion(id).then((ok) => ok && this.paste(id, text, false))
  }

  private async whenNoQuestion(id: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const s = this.sessions.get(id)
      if (!s) return false
      if (!detectPrompt(s.screen.view()) && s.tracker.status !== 'needs-you') return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /**
   * Type a message and press Enter, then make sure it was taken: right after startup a CLI can swallow
   * the first Enter while it settles, leaving the message in its input box. Retries a couple of times.
   */
  typeAndSubmit(id: string, text: string) {
    this.paste(id, text, false)
    this.submitTyped(id, text, 0)
  }

  private submitTyped(id: string, text: string, attempt: number) {
    setTimeout(
      () => {
        if (!this.sessions.has(id)) return
        // on a retry, report focus first: that unsticks an input box that ignored the first Enter
        if (attempt) this.write(id, '\x1b[I')
        this.write(id, '\r')
        setTimeout(() => {
          if (attempt >= 2 || this.status(id) !== 'idle') return
          const probe = text.slice(0, 40).replace(/\s+/g, ' ')
          const screen = this.tail(id, 1200).replace(/\s+/g, ' ')
          // still at the bottom of the screen and the CLI never started working: Enter again
          if (screen.lastIndexOf(probe) > screen.length - text.length - 400) this.submitTyped(id, text, attempt + 1)
        }, 1500)
      },
      attempt ? 200 : this.sessions.get(id)?.bracketed ? 150 : 350
    )
  }

  /**
   * Type a message once the console can take it (it may still be starting: Claude Code drops input
   * typed while it draws its startup notices), then make sure it was submitted. False if the console
   * ended or never became ready.
   */
  async deliver(id: string, text: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    const until = Date.now() + timeoutMs
    let seen = false
    while (Date.now() < until) {
      if (this.sessions.has(id)) seen = true
      else if (seen) return false
      if (this.readyForInput(id)) {
        this.typeAndSubmit(id, text)
        return true
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
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
    // Claude Code says which conversation it is in: after /clear or a resume without an id it changes
    const sid = event === 'SessionStart' ? (payload as { session_id?: unknown } | null)?.session_id : undefined
    if (validSessionId(sid) && sid !== s.sessionId) {
      s.sessionId = sid
      this.emit('pty:session', id, sid)
    }
    s.tracker.hookEvent(event, payload, Date.now())
    this.evaluate(s)
  }

  private evaluate(s: Session) {
    const prev = s.tracker.status
    const next = s.tracker.evaluate(Date.now(), detectPrompt(s.screen.view()))
    if (next !== prev) this.emit('pty:status', s.id, next)
    // after a turn (idle, with new output since the last look): find which saved session is this console's
    const d = s.discover
    if (d && next === 'idle' && s.outputAt > d.lastTry && Date.now() - d.lastTry > 2000) this.discoverSession(s)
  }

  /** Which of the CLI's saved sessions is this console's (see findCodexSession). */
  private discoverSession(s: Session) {
    const d = s.discover!
    d.lastTry = Date.now()
    if (++d.tries > 100) return (s.discover = undefined)
    const claimed = new Set([...this.sessions.values()].map((x) => x.sessionId).filter((x): x is string => !!x))
    const found = findCodexSession(d.env, { cwd: d.cwd, since: d.since, claimed, screen: s.screen.text(20000) })
    if (!found || this.sessions.get(s.id) !== s) return
    s.sessionId = found
    s.discover = undefined
    this.emit('pty:session', s.id, found)
  }

  private refreshStatuses() {
    for (const s of this.sessions.values()) this.evaluate(s)
  }

  /** Called when a console's process has started. */
  onSpawn(listener: SpawnListener) {
    this.spawnListeners.add(listener)
    return () => this.spawnListeners.delete(listener)
  }

  /** Called when a console's process ends, with its exit code. */
  onExit(listener: ExitListener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /**
   * End every console (the app is quitting). Like closing a terminal: SIGHUP to each console's process
   * group; then SIGKILL for whatever is still running, since some CLIs ignore SIGHUP (Gemini CLI does)
   * and would outlive the app.
   */
  async dispose(graceMs = 600): Promise<void> {
    this.disposing = true
    clearInterval(this.tick)
    const live = [...this.sessions.values()]
    for (const s of live) {
      if (s.tracker.paused) this.signal(s, 'SIGCONT')
      this.signal(s, 'SIGHUP')
    }
    const running = () => live.filter((s) => this.sessions.get(s.id) === s)
    const until = Date.now() + graceMs
    while (running().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    for (const s of running()) this.signal(s, 'SIGKILL')
  }

  get size() {
    return this.sessions.size
  }
}
