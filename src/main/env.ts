import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)

let cached: Record<string, string> | null = null

/**
 * The environment of the user's login shell. A desktop launcher often starts the app without the PATH
 * that mise / nvm / ~/.local/bin add, so agents would not be found. We read it once from `$SHELL -lic`.
 */
export async function loginEnv(): Promise<Record<string, string>> {
  if (cached) return cached
  const shell = process.env.SHELL || '/bin/bash'
  const base = { ...process.env } as Record<string, string>
  try {
    const { stdout } = await run(shell, ['-lic', 'env -0'], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 })
    for (const entry of stdout.split('\0')) {
      const i = entry.indexOf('=')
      if (i > 0) base[entry.slice(0, i)] = entry.slice(i + 1)
    }
  } catch {
    // fall back to the process env
  }
  // Launched from inside a Claude Code session (or another agent), the parent's session variables
  // would leak into every console and change how those CLIs behave. Start them clean.
  // (Not where an administrator points Gemini CLI at its system settings: that is configuration.)
  for (const k of Object.keys(base))
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_SANDBOX|GEMINI_CLI_)/.test(k) && !/^GEMINI_CLI_SYSTEM_(SETTINGS|DEFAULTS)_PATH$/.test(k)) delete base[k]
  base.TERM = 'xterm-256color'
  base.COLORTERM = 'truecolor'
  base.TERM_PROGRAM = 'Fleetboard'
  delete base.ELECTRON_RUN_AS_NODE
  delete base.ELECTRON_NO_ATTACH_CONSOLE
  cached = base
  return base
}

export const shellPath = () => process.env.SHELL || '/bin/bash'
export const home = () => os.homedir()

/** `which` against the login PATH. */
/** Where an executable is, searched on the login PATH like a shell does (no `which` program needed). */
export async function which(bin: string): Promise<string | null> {
  if (bin === '$SHELL') return shellPath()
  const runnable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (bin.includes('/')) return runnable(bin) ? path.resolve(bin) : null
  const env = await loginEnv()
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, bin)
    if (runnable(p)) return p
  }
  return null
}
