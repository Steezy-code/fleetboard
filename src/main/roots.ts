import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirs } from './paths'
import { logError } from './errors'
import { currentProject, getGlobal, setGlobal } from './store'

// Which paths the filesystem handlers may touch.
//
// fsops.ts took any absolute path: fs:read, fs:write, fs:mkdir and the fbfile:// protocol would reach
// anywhere the user can. The renderer is the trust boundary and it is defended (the allowlist
// sanitizer, a narrow CSP), but a board file is written by the agents the app runs, and node paths out
// of it are handed straight back to these handlers — so "the renderer asked for it" is not on its own
// a reason to serve it.
//
// Allowed: the open project, ~/.fleetboard, and whatever the user picked themselves — a dialog, or a
// file dropped on the board. Those last two have to be remembered across launches, because a picked
// image is written into the board as a node and re-read on every later open.

/** Where grants are persisted (a global, so they survive a restart and are shared across boards). */
const GRANTS_KEY = 'fsGrants'
/** Keep the most recent grants only, so the list cannot grow without limit. */
const MAX_GRANTS = 200

export interface Grant {
  /** absolute, already resolved */
  path: string
  /** a folder grant allows its whole subtree; a file grant allows that file and its siblings */
  dir: boolean
}

/** Windows and macOS compare paths without case; Linux does not. */
const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)

/** `child` is `root` itself or inside it. Both sides resolved; the separator stops `foo-old` passing as `foo`. */
function within(child: string, root: string): boolean {
  const c = fold(child)
  const r = fold(path.resolve(root))
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * The folder the renderer says it is opening, from store:projectId — which is the first thing
 * openProject does, before anything is read.
 *
 * It cannot come from store.currentProject() alone: that is set when a board is loaded or saved, and
 * a folder opened for the first time has no saved board, so the Code studio reads its tree before any
 * save has happened. Honest about what this does and does not buy: the open project is declared by
 * the renderer, because choosing a folder to work in is what the renderer is for, so a compromised
 * renderer could declare a different one and read that. What it cannot do any more is read outside
 * the folder it declared — no ~/.ssh while a project is open, no writes anywhere else, and
 * fbfile:// bounded the same way. Making the root itself unforgeable would mean the main process
 * owning project selection, which is a larger change than this.
 */
let declared: string | null = null

/** The folder the renderer last declared it is opening (declareProject), or null. */
export const declaredProject = () => declared

/**
 * The folder the renderer is opening. Ignored unless it is a directory that exists. Returns the
 * folder it took, or null when it took none.
 */
export function declareProject(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || !path.isAbsolute(p)) return null
  const abs = path.resolve(p)
  try {
    if (fs.statSync(abs).isDirectory()) {
      declared = abs
      return abs
    }
  } catch {
    /* not a folder: leave the previous one */
  }
  return null
}

let cache: Grant[] | null = null

function grants(): Grant[] {
  if (cache) return cache
  const raw = getGlobal<unknown>(GRANTS_KEY)
  const list = Array.isArray(raw) ? raw : []
  cache = list
    .filter((g): g is Grant => !!g && typeof g === 'object' && typeof (g as Grant).path === 'string')
    .map((g) => ({ path: path.resolve(g.path), dir: !!g.dir }))
  return cache
}

/**
 * Remember a path the user chose: a dialog result, or a file dropped on the board.
 *
 * A folder is granted as a subtree — the user picked it to work in. A file is granted as itself plus
 * its siblings, not its subtree: a dropped markdown file renders relative images next to it, and a
 * picked image sits beside others, but neither is a reason to open every folder below.
 */
export function grant(p: string): void {
  if (typeof p !== 'string' || !p.trim()) return
  const abs = path.resolve(p)
  let dir = false
  try {
    dir = fs.statSync(abs).isDirectory()
  } catch {
    // a dialog:saveFile target does not exist yet, and is a file
  }
  const list = grants().filter((g) => !(g.dir === dir && fold(g.path) === fold(abs)))
  list.push({ path: abs, dir })
  cache = list.slice(-MAX_GRANTS)
  setGlobal(GRANTS_KEY, cache)
}

/**
 * A file or folder dropped on the board. Only the preload sends it, for a real file, but a dropped
 * folder is never the disk's root, the home folder or one above it: that grant would outlive the
 * session and switch confinement off for good.
 */
export function grantDropped(p: string): void {
  if (typeof p !== 'string' || !p.trim()) return
  const abs = path.resolve(p)
  let dir = false
  try {
    dir = fs.statSync(abs).isDirectory()
  } catch {
    return // a drop is of something that exists
  }
  if (dir && !plausibleRoot(abs)) {
    logError('roots', `a dropped folder too wide to grant: ${abs}`)
    return
  }
  grant(abs)
}

/**
 * A folder that could plausibly be a project: not the filesystem root, not the home directory
 * itself, not an ancestor of it.
 *
 * This is the check that makes the rest of the confinement worth having. A board file names its own
 * folder and board files are written by the agents the app runs, so a board claiming `path: "/"` or
 * `path: "~"` would otherwise turn the whole disk — or every dotfile — into the project and allow
 * exactly what this is here to prevent. The user can still work in their home folder: picking it in
 * the open dialog grants it (below), which is the user saying so rather than a file saying so.
 */
function plausibleRoot(abs: string): boolean {
  if (fold(abs) === fold(path.parse(abs).root)) return false
  // an ancestor of the home directory, or the home directory itself
  let home: string
  try {
    home = path.resolve(os.homedir())
  } catch {
    return true
  }
  return !within(home, abs)
}

/** The folder the open board is for, or null when there is none — or when it is not a folder a board
 *  may claim (see plausibleRoot). */
export function projectRoot(): string | null {
  const open = currentProject()?.path
  const claimed = open ? path.resolve(open) : declared
  if (!claimed) return null
  if (plausibleRoot(claimed)) return claimed
  once(`root:${claimed}`, () => logError('roots', `the open board claims ${claimed} as its folder, which is too broad to allow`))
  return null
}

/** Every root currently allowed, for a message or a test. */

export function allowedRoots(): string[] {
  const project = projectRoot()
  return [dirs.root, ...(project ? [project] : []), ...grants().map((g) => g.path)]
}

/**
 * The path as an absolute one, or null when it cannot be made absolute.
 *
 * A relative path means "inside the open board" — some callers pass one (the content smoke test sends
 * `src/app.ts`). Resolving it against the main process's cwd would silently point somewhere
 * unrelated, so it is resolved against the project instead.
 */
export function absolutePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  if (path.isAbsolute(p)) return path.resolve(p)
  const project = projectRoot()
  return project ? path.resolve(project, p) : null
}

/**
 * May this path be read or written?
 *
 * Checked on the path as given (once resolved), not on its realpath. writeText deliberately follows a
 * symlink so a symlinked dotfile is written where it points rather than replaced by a plain file, and
 * a test pins that; authorizing on the realpath would refuse exactly those. The residual is a symlink
 * already inside the project redirecting a write out of it — which needs write access to the project,
 * and is not reachable from a hostile board file or a hostile markdown file, which is what this is for.
 */
/**
 * Inside the app's own folder, what only the main process reads or writes: sign-ins (a profile is a
 * CLI's config dir, its tokens included), the hook script every Claude console runs, the teams'
 * MCP tokens and Gemini homes, the phone link's secret, and app.json, which holds the grants
 * themselves. Allowing all of ~/.fleetboard put each of these in reach of a path out of a board
 * file, and a write to app.json was a way round mainOwnedGlobal after the next restart.
 */
const PRIVATE = ['profiles', 'hooks', 'fleet', 'gemini-homes', 'projects', 'history', 'no-hooks', 'remote.json', 'app.json', 'consoles-running.json', 'usage-cache.json']

/** Inside one of the app folder's private parts (PRIVATE), whatever else would allow it. */
export function privatePath(abs: string): boolean {
  return PRIVATE.some((p) => within(abs, path.join(dirs.root, p)))
}

export function insideAllowed(p: unknown): boolean {
  const abs = absolutePath(p)
  if (!abs) return false
  // before any root: a project or a grant that contains the app folder does not open these either
  if (privatePath(abs)) return false
  if (within(abs, dirs.root)) return true
  const project = projectRoot()
  if (project && within(abs, project)) return true
  const parent = path.dirname(abs)
  for (const g of grants()) {
    if (g.dir ? within(abs, g.path) : fold(abs) === fold(g.path) || fold(parent) === fold(path.dirname(g.path))) return true
  }
  return false
}

const told = new Set<string>()

/** Log something once per key, so a wrong root is diagnosable without flooding the log. */
function once(key: string, say: () => void): void {
  if (told.size >= 500 || told.has(key)) return
  told.add(key)
  say()
}

/**
 * Refuse a path, loudly enough to diagnose and quietly enough not to flood: each path is logged once.
 * Returns false so a caller can `if (!allowed(p, 'fs:read')) return null`.
 */
export function allowed(p: unknown, what: string): boolean {
  return allowedPath(p, what) !== null
}

/**
 * The path, made absolute exactly as it was checked, or null when it is refused.
 *
 * Callers must use *this* for the operation, never the path they were given. A relative path is
 * checked against the open project (absolutePath), but fs, git and child processes resolve one against
 * the main process's working directory — so `.ssh/id_rsa` passed as `<project>/.ssh/id_rsa` and was
 * then read as `<cwd>/.ssh/id_rsa`, which for an app started from a desktop launcher is the home
 * folder. The check and the use are the same path only when the use is handed the checked one.
 */
export function allowedPath(p: unknown, what: string): string | null {
  const abs = absolutePath(p)
  if (abs && insideAllowed(abs)) return abs
  once(`${what}:${String(p)}`, () => logError('roots', `${what} refused: ${String(p)} is outside ${allowedRoots().join(', ')}`))
  return null
}

/**
 * Globals the main process owns. The grants are the whole allowed set beyond the project, so a
 * renderer that could write them straight through store:setGlobal — which takes any key — would not
 * need to get past any of this. It may still read them: they are paths the user picked themselves.
 */
export function mainOwnedGlobal(key: unknown): boolean {
  return key === GRANTS_KEY
}

/** The message a write or an open is refused with. */
export const outsideMessage = (p: unknown) => `Outside the folders Fleetboard may use: ${String(p)}`

/** Tests only: forget every grant, in memory and on disk. */
export function resetGrantsForTest(): void {
  declared = null
  cache = []
  setGlobal(GRANTS_KEY, [])
  cache = null
  told.clear()
}

/** Tests only: drop the in-memory copy and read the stored grants again, as a restart does. */
export function reloadGrantsForTest(): void {
  cache = null
}
