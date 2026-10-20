import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { MainContext } from './context'
import { loginEnv } from './env'
import { IS_WIN, killTree, launchOptions, oneShot } from './platform'
import { stripAnsi } from '@shared/ansi'

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

export function runGoalCheck(cwd: string, command: string, timeoutMs = 15 * 60_000): Promise<GoalCheck> {
  return new Promise((resolve) => {
    if (!command.trim()) return resolve({ code: null, tail: '', error: 'no command' })
    if (!fs.existsSync(cwd)) return resolve({ code: null, tail: '', error: `folder not found: ${cwd}` })
    void loginEnv().then((env) => {
      let out = ''
      const keep = (d: Buffer) => {
        out = (out + d.toString()).slice(-TAIL * 4)
      }
      // its own process group (POSIX), so a timeout ends whatever it started too; Windows ends the tree
      const l = oneShot(command, env)
      const child = spawn(l.file, l.args, { cwd, env: { ...env, CI: '1' }, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'], ...launchOptions(l) })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, timeoutMs)
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: null, tail: '', error: e.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: timedOut ? null : code, tail: stripAnsi(out).slice(-TAIL), ...(timedOut ? { timedOut } : {}) })
      })
    })
  })
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('goal:check', (_e, cwd: string, command: string) => runGoalCheck(String(cwd), String(command)))
}
