// What differs between Linux/macOS and Windows, in one place: which shell a console runs, how an
// executable is found and started (npm's .cmd wrappers on Windows), and how a process and everything it
// started is ended (process groups and signals on POSIX, the process tree on Windows).
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const IS_WIN = process.platform === 'win32'

// ---------------------------------------------------------------- finding executables

/** Windows: the extensions a bare command name may have, in the order the shell tries them. */
export function pathExts(env: Record<string, string | undefined> = process.env): string[] {
  if (!IS_WIN) return ['']
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/** The PATH value, whatever the variable's case (Windows spells it `Path`). */
export function pathOf(env: Record<string, string | undefined>): string {
  if (env.PATH !== undefined) return env.PATH
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return key ? (env[key] ?? '') : ''
}

/** One `PATH` key (Windows children get two otherwise: `Path` and `PATH`, and which one wins varies). */
export function normalizePathKey(env: Record<string, string>) {
  if (!IS_WIN) return env
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
  if (keys.length === 1 && keys[0] === 'PATH') return env
  const value = keys.map((k) => env[k]).find(Boolean) ?? ''
  for (const k of keys) delete env[k]
  env.PATH = value
  return env
}

const isFile = (p: string) => {
  try {
    if (!fs.statSync(p).isFile()) return false
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Where an executable is, searched like a shell does: PATH, plus PATHEXT on Windows. */
export function findExecutable(bin: string, env: Record<string, string | undefined>): string | null {
  const exts = pathExts(env)
  const hasExt = IS_WIN && exts.includes(path.extname(bin).toLowerCase())
  const candidates = (base: string) => (IS_WIN && !hasExt ? exts.map((e) => base + e) : [base])
  if (bin.includes('/') || (IS_WIN && bin.includes('\\'))) {
    for (const c of candidates(bin)) if (isFile(c)) return path.resolve(c)
    return null
  }
  for (const dir of pathOf(env).split(path.delimiter)) {
    if (!dir) continue
    for (const c of candidates(path.join(dir, bin))) if (isFile(c)) return c
  }
  return null
}

// ---------------------------------------------------------------- starting executables

export interface Launch {
  file: string
  args: string[]
}

/**
 * npm's Windows wrapper (claude.cmd, gemini.cmd…) ends in `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`:
 * the script it runs with node. Null when the file is not such a wrapper.
 */
export function shimScript(cmdFile: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(cmdFile, 'utf8')
  } catch {
    return null
  }
  const rel = /"%~?dp0%?\\?([^"%]+\.(?:c?js|mjs))"\s+%\*/i.exec(text)?.[1]
  if (!rel) return null
  const script = path.join(path.dirname(cmdFile), ...rel.split(/[\\/]+/))
  return fs.existsSync(script) ? script : null
}

/**
 * cmd.exe quoting for one argument (inside `cmd /d /s /c "…"`).
 *
 * A double quote is doubled (""), not backslash-escaped. \" is a C-runtime convention that cmd.exe
 * does not honour: cmd counts raw quote characters, so \" ends the quoted run as far as its own
 * metacharacter scan is concerned, and whatever follows — &, |, another quote — is read as shell
 * syntax. That is the BatBadBut class of bug, and it is reachable here because cli.ts sends
 * model-written prompts to a CLI installed as a .cmd that is not an npm shim. "" is read as a
 * literal quote both by cmd and by the C runtime that parses argv on the other side.
 *
 * Not neutralised: % inside quotes is expanded by cmd and cannot be escaped on a command line, so
 * an argument naming an existing variable has its value substituted. That reads an environment
 * value into the prompt; it does not end the quoted run, so it cannot start a command.
 */
export function cmdQuote(arg: string): string {
  if (arg && !/[\s"&|<>^%(),;=!]/.test(arg)) return arg
  // backslashes mean something to the C runtime only right before a quote: a run of them there is
  // doubled (it reads 2n as n, then the quote), as is a run before the closing quote. Left single, a
  // \" in a prompt read as an escaped quote, the next one closed the argument early, and the rest of
  // the prompt arrived as arguments of its own: flags included.
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`
}

/**
 * How to start `file` with `args`. On Windows a .cmd/.bat can't be started directly (Node refuses since
 * 20.12, and quoting through cmd.exe mangles multi-line prompts), so an npm wrapper runs its script with
 * node instead; any other batch file goes through cmd.exe.
 */
export function launch(file: string, args: string[], env: Record<string, string | undefined>): Launch {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  const script = shimScript(file)
  if (script) {
    const local = path.join(path.dirname(file), 'node.exe')
    const node = fs.existsSync(local) ? local : (findExecutable('node', env) ?? 'node')
    return { file: node, args: [script, ...args] }
  }
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`] }
}

/** child_process options a launch needs (cmd.exe's own quoting must reach it as written). */
export const launchOptions = (l: Launch) => (IS_WIN && /cmd\.exe$/i.test(l.file) ? { windowsVerbatimArguments: true, windowsHide: true } : { windowsHide: true })

/**
 * The user's home as agent CLIs see it: $HOME on POSIX; on Windows the profile folder (USERPROFILE),
 * which is where Claude Code, Codex and Gemini keep their files even when Git Bash sets HOME.
 */
export const homeOf = (env: Record<string, string | undefined>) => (IS_WIN ? env.USERPROFILE : env.HOME) || os.homedir()

/** Paths the renderer sees use forward slashes on Windows too (C:/dir/file): one form to compare. */
export const toRendererPath = (p: string) => (IS_WIN ? p.replace(/\\/g, '/') : p)

// ---------------------------------------------------------------- shells

let winShell: string | null = null
/** The shell a console runs: $SHELL on POSIX; PowerShell 7 if installed, else Windows PowerShell. */
export function defaultShell(env: Record<string, string | undefined> = process.env): string {
  if (!IS_WIN) return process.env.SHELL || '/bin/bash'
  winShell ??= findExecutable('pwsh', env) ?? findExecutable('powershell', env) ?? (env.ComSpec || 'cmd.exe')
  return winShell
}

const isPowerShell = (shell: string) => /(pwsh|powershell)(\.exe)?$/i.test(shell)

/** Arguments for an interactive shell console. */
export function shellArgs(shell: string): string[] {
  if (!IS_WIN) return ['-l']
  return isPowerShell(shell) ? ['-NoLogo'] : []
}

/** A console that runs one command, then stays in the shell (a dev server, a watcher). */
export function shellCommandArgs(shell: string, command: string): string[] {
  if (!IS_WIN) return ['-lc', `${command}; exec ${shell} -l`]
  return isPowerShell(shell) ? ['-NoLogo', '-NoExit', '-Command', command] : ['/k', command]
}

/** Run a command line and exit (goal checks): [file, args]. */
export function oneShot(command: string, env: Record<string, string | undefined> = process.env): Launch {
  if (!IS_WIN) return { file: defaultShell(env), args: ['-lc', command] }
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', `"${command}"`] }
}

// ---------------------------------------------------------------- ending processes

/**
 * End a process and everything it started. POSIX: its process group (it must lead one: detached, or a
 * pty's session). Windows: the process tree, forcefully (there are no signals to ask nicely with).
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL') {
  if (!pid) return
  if (IS_WIN) {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    } catch {
      /* gone */
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* gone */
    }
  }
}

/** Same, but waits for taskkill (app quit: nothing may outlive the window). */
export function killTreeSync(pid: number | undefined) {
  if (!pid) return
  if (!IS_WIN) return killTree(pid)
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  } catch {
    /* gone */
  }
}

/**
 * Link `link` to `target` without needing admin rights on Windows: a directory becomes a junction; a
 * file a symlink, or a copy where Windows refuses symlinks (no Developer Mode).
 */
export function linkPath(target: string, link: string) {
  const isDir = fs.statSync(target).isDirectory()
  if (isDir) return fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir')
  try {
    fs.symlinkSync(target, link, 'file')
  } catch (e) {
    if (!IS_WIN) throw e
    fs.copyFileSync(target, link)
  }
}

