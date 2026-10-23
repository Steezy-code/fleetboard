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
import { activityOf } from './activity'
import type { AnswerResult, PromptAnswer } from '@shared/prompt'
import { approvalFor, commandOf, seenOf } from '@shared/approvals'
import { RunRecord } from './orphans'
import { CAN_PAUSE, IS_WIN, killTree, killTreeSync, launch, shellArgs, shellCommandArgs } from './platform'

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
  /** started with its auto-approval flag: it keeps it whatever the setting says later */
  autoApproves: boolean
  /** the conversation the CLI runs under, when known (AgentDef.session, or Claude's SessionStart hook) */
  sessionId?: string
  /** a CLI that picks its own id (Codex): where to look for it after a turn */
  discover?: { since: number; cwd: string; env: Record<string, string | undefined>; tries: number; lastTry: number }
  /** when the CLI last printed something */
  outputAt: number
  /** what it is doing (activity.ts), and the output it was last read from */
  activity: string | null
  activityAt: number
  /**
   * an agent CLI: everything in its process group ends with the console. A shell's (the user's own
   * terminal) is left as a terminal leaves it: what the user started with nohup outlives it.
   */
  agentGroup: boolean
}

export { stripAnsi } from '@shared/ansi'

/** Everything the console started: its process group (POSIX), its process tree (Windows). */
const killGroup = (pid: number) => killTree(pid, 'SIGKILL')

type ExitListener = (id: string, code: number | undefined, appClosing: boolean) => void
type SpawnListener = (req: PtySpawnRequest) => void

/** Text the board types, and only text: a carriage return, Ctrl-C or an escape inside it would act as a key. */
export const pasteText = (text: string) => text.replace(/\r?\n|\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')

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
    // the hook token only where Claude Code's hooks use it: any other process holding it could report for this console
    const hooked = agent?.id === 'claude' && !req.command
    const env = { ...(await loginEnv()), ...(hooked ? hookEnv(req.id) : {}), ...profileEnv(req.agentId, req.profileId) }
    env.FB_CONSOLE_ID = req.id

    let file: string
    let args: string[] = []
    let sessionId: string | undefined
    let notice = ''
    let lost = false
    let autoApproves = false
    if (req.command) {
      // a console started for one command (dev server, watcher); drop into a shell when it ends
      file = shellPath()
      args = shellCommandArgs(file, req.command)
    } else if (!agent || agent.id === 'shell') {
      file = shellPath()
      args = shellArgs(file)
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
      autoApproves = !!yolo
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

    // Windows: an npm wrapper (claude.cmd) runs its script with node instead
    const start = launch(file, args, env)
    const proc = pty.spawn(start.file, start.args, {
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
      autoApproves,
      sessionId,
      discover:
        agent?.session && !agent.session.start && !sessionId && !req.command
          ? { since: startedAt, cwd: req.cwd, env: { HOME: env.HOME, CODEX_HOME: env.CODEX_HOME }, tries: 0, lastTry: startedAt }
          : undefined,
      outputAt: startedAt,
      activity: null,
      activityAt: 0,
      agentGroup: !req.command && !!agent && agent.id !== 'shell'
    }
    this.sessions.set(req.id, s)
    this.record.add(req.id, proc.pid, s.agentGroup)
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
    return { id: s.id, pid: s.proc.pid, agentId: s.agentId, status: s.tracker.status, startedAt: s.startedAt, sessionId: s.sessionId, autoApproves: s.autoApproves }
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

  /** Close a console and wait until its processes have ended (at most the SIGKILL fallback, ~2.5 s). */
  stop(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return Promise.resolve()
    const gone = new Promise<void>((resolve) => {
      const off = this.onExit((exited) => {
        if (exited === id && this.sessions.get(id) !== s) (off(), resolve())
      })
      // whatever happens, not for ever
      setTimeout(() => (off(), resolve()), 4000).unref?.()
    })
    this.kill(id)
    return gone
  }

  kill(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.tracker.paused) this.signal(s, 'SIGCONT')
    if (IS_WIN) {
      // no hangup to send: end the console's process tree
      killGroup(s.proc.pid)
      return
    }
    // like closing a terminal: the whole group hangs up
    this.signal(s, 'SIGHUP')
    // then whatever ignored that: an agent CLI's group whether or not the CLI has ended (Gemini CLI; a
    // child it started), a shell's only while the shell itself runs on
    setTimeout(() => {
      if (s.agentGroup || this.sessions.get(id) === s) killGroup(s.proc.pid)
    }, 2500)
  }

  private signal(s: Session, sig: NodeJS.Signals) {
    if (IS_WIN) return // no signals; kill() ends the tree instead
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
    if (!s || s.tracker.paused || !CAN_PAUSE) return
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
    const clean = pasteText(text)
    this.write(id, s.bracketed ? `\x1b[200~${clean}\x1b[201~` : clean)
    if (submit) setTimeout(() => void this.enter(id), s.bracketed ? 150 : 350)
  }

  /**
   * Enter after text the board typed, pressed only while no question is on screen. A permission dialog
   * that appeared between the paste and this Enter would take it as its answer (Enter picks the
   * highlighted option, usually "Yes"); then the text stays typed and is submitted once the question
   * has been answered.
   */
  private async enter(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    await s.screen.flush()
    if ((detectPrompt(s.screen.view()) || s.tracker.status === 'needs-you') && !(await this.whenNoQuestion(id))) return
    if (this.sessions.has(id)) this.write(id, '\r')
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
        void this.enter(id)
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
   * types into a console whose question was already answered in its terminal. `command`: answer only
   * while the prompt still asks to run exactly this command (a team rule's yes is for nothing else).
   */
  async answer(id: string, answer: PromptAnswer, command?: string): Promise<AnswerResult> {
    const s = this.sessions.get(id)
    if (!s) return { ok: false, reason: 'not-live' }
    await s.screen.flush()
    const prompt = detectPrompt(s.screen.view())
    if (command !== undefined && commandOf(prompt) !== command) return { ok: false, reason: prompt ? 'changed' : 'gone' }
    if (answer.seen !== undefined) {
      // given on a card: the screen must still make that card, and the option must be one it offered
      // (a card leaves out options such as "switch to auto mode"; the CLI's menu still has them)
      const card = approvalFor(prompt)
      if (!card) return { ok: false, reason: prompt ? 'changed' : 'gone' }
      if (seenOf(card) !== answer.seen) return { ok: false, reason: 'changed' }
      if ('option' in answer && !card.options.some((o) => 'option' in o.answer && o.answer.option === answer.option)) return { ok: false, reason: 'changed' }
    }
    const keys = answerKeys(prompt, answer, s.screen.appCursorKeys)
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

  infoOf(id: string): PtyInfo | null {
    const s = this.sessions.get(id)
    return s ? this.info(s) : null
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
    this.readActivity(s, next)
    // after a turn (idle, with new output since the last look): find which saved session is this console's
    const d = s.discover
    if (d && next === 'idle' && s.outputAt > d.lastTry && Date.now() - d.lastTry > 2000) this.discoverSession(s)
  }

  /**
   * What the console is doing, read only while it works and only when it printed something since the
   * last read: on this tick, an idle board costs nothing. A permission prompt keeps the step it is
   * asking about ("running `npm test`"), which is what the Inbox card is about too.
   */
  private readActivity(s: Session, status: ConsoleStatus) {
    const busy = status === 'working' || status === 'needs-you'
    const was = s.activity
    if (!busy) s.activity = null
    else if (s.outputAt > s.activityAt) {
      s.activityAt = s.outputAt
      s.activity = activityOf(s.agentId, s.screen.text(6000))
    }
    if (s.activity !== was) this.emit('pty:activity', s.id, s.activity)
  }

  /** When a console last printed anything, or null when it is not running. */
  lastOutput(id: string): number | null {
    return this.sessions.get(id)?.outputAt ?? null
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
    if (IS_WIN) {
      // the window is going: end every console's tree before it does
      for (const s of live) killTreeSync(s.proc.pid)
      return
    }
    for (const s of live) {
      if (s.tracker.paused) this.signal(s, 'SIGCONT')
      this.signal(s, 'SIGHUP')
    }
    const running = () => live.filter((s) => this.sessions.get(s.id) === s)
    const until = Date.now() + graceMs
    while (running().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    // an agent CLI's group even when the CLI has ended: a child it started may ignore the hangup the CLI
    // took (a group's id is not given to another process while the group exists)
    for (const s of live) if (s.agentGroup || this.sessions.get(s.id) === s) killGroup(s.proc.pid)
  }

  get size() {
    return this.sessions.size
  }
}
