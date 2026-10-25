import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { MainContext } from './context'
import { loginEnv } from './env'
import { IS_WIN, killTree, launchOptions, oneShot } from './platform'
import { stripAnsi } from '@shared/ansi'
import { allowedPath, outsideMessage } from './roots'

// A loop's "stop when this command passes" check: run the command the user wrote in the project, in
// their login shell, and read its exit code. Not a model asked to run it: that cannot edit the code it
// is judging, costs nothing and cannot misreport.

export interface GoalCheck {
  /** exit code; null when it could not run or was stopped */
  code: number | null
  /** the end of what it printed */
  tail: string
  timedOut?: boolean
  error?: string
}

const TAIL = 4000

/**
 * Goal checks in flight. They are spawned detached (their own process group, so a timeout ends
 * whatever they started) with a 15-minute timeout, and nothing knew about them at quit: `npm test`
 * started a minute before the user quit carried on as its own session leader with the app gone, and
 * the next launch's orphan reaper had no record of it either.
 */
const running = new Set<ReturnType<typeof spawn>>()

/** End every goal check. Called when the app quits. */
export function killGoalChecks() {
  for (const child of running) killTree(child.pid)
  running.clear()
}

/** `signal`: whoever started it can end it early (a team dismissed mid-check); it then resolves as stopped. */
export function runGoalCheck(cwd: string, command: string, timeoutMs = 15 * 60_000, signal?: AbortSignal): Promise<GoalCheck> {
  return new Promise((resolve) => {
    if (!command.trim()) return resolve({ code: null, tail: '', error: 'no command' })
    if (signal?.aborted) return resolve({ code: null, tail: '', error: 'stopped' })
    if (!fs.existsSync(cwd)) return resolve({ code: null, tail: '', error: `folder not found: ${cwd}` })
    void loginEnv().catch(() => process.env as Record<string, string>).then((env) => {
      let out = ''
      const keep = (d: Buffer) => {
        out = (out + d.toString()).slice(-TAIL * 4)
      }
      // its own process group (POSIX), so a timeout ends whatever it started too; Windows ends the tree
      const l = oneShot(command, env)
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(l.file, l.args, { cwd, env: { ...env, CI: '1' }, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'], ...launchOptions(l) })
      } catch (e: any) {
        // spawn throws, rather than emitting 'error', for some bad arguments: this promise must still
        // settle, or a live check stays "in flight" and never runs again
        return resolve({ code: null, tail: '', error: String(e?.message ?? e) })
      }
      running.add(child)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, timeoutMs)
      const stop = () => killTree(child.pid)
      signal?.addEventListener('abort', stop, { once: true })
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      child.on('error', (e) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        running.delete(child)
        resolve({ code: null, tail: '', error: e.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        running.delete(child)
        const stopped = !timedOut && !!signal?.aborted
        resolve({ code: timedOut || stopped ? null : code, tail: stripAnsi(out).slice(-TAIL), ...(timedOut ? { timedOut } : {}), ...(stopped ? { error: 'stopped' } : {}) })
      })
    })
  })
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('goal:check', (_e, cwd: string, command: string) => {
    // The command is the user's own — that is what a loop's goal is — but where it runs is not: the
    // folder arrives over IPC, and a loop lives in the board file. Nothing is lost by requiring it to
    // be a folder Fleetboard may touch, and this is the sharpest handler on the surface: it runs
    // `$SHELL -lc <command>` for fifteen minutes.
    const abs = allowedPath(cwd, 'goal:check')
    if (!abs) throw new Error(outsideMessage(cwd))
    return runGoalCheck(abs, String(command))
  })
}
