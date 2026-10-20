import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// FLEETBOARD_HOME lets a second instance (demos, tests) keep its own state.
export const ROOT = process.env.FLEETBOARD_HOME || path.join(os.homedir(), '.fleetboard')
export const dirs = {
  root: ROOT,
  projects: path.join(ROOT, 'projects'),
  history: path.join(ROOT, 'history'),
  profiles: path.join(ROOT, 'profiles'),
  hooks: path.join(ROOT, 'hooks'),
  exports: path.join(ROOT, 'exports'),
  assets: path.join(ROOT, 'assets')
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })

/** Make a rename durable: the directory entry itself has to reach the disk. */
function syncDir(dir: string) {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* Windows cannot fsync a directory and some filesystems refuse it: the rename still happened */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Write JSON atomically so a crash mid-write never corrupts state. `mode` 0o600 for files only the
 * user may read. `pretty: false` for files nobody reads by hand.
 *
 * Rename is atomic for the *name*, which is what stops a half-written file ever being seen under the
 * real one — but on its own it says nothing about when the new contents reach the disk. Without the
 * fsync, a power loss seconds after a save could leave the board file present and empty, or holding
 * a torn tail; the recovery path in store.ts would then set it aside and fall back to a snapshot, so
 * the user loses up to five minutes of work for a write that had already "succeeded".
 */
export function writeJsonAtomic(file: string, value: unknown, mode?: number, opts: { pretty?: boolean } = {}) {
  const tmp = `${file}.${process.pid}.tmp`
  const text = opts.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  try {
    const fd = fs.openSync(tmp, 'w', mode ?? 0o666)
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (mode !== undefined) fs.chmodSync(tmp, mode)
    renameRetrying(tmp, file)
    syncDir(path.dirname(file))
  } catch (e) {
    // a failed write must not leave its temporary file behind: a full disk would otherwise litter one
    // per save, in the folder that is already out of room
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing more to be done about it */
    }
    throw e
  }
}

/**
 * Windows refuses a rename for a moment while something holds the target open (antivirus, the search
 * indexer, a backup tool): try a few times before giving up.
 */
export function renameRetrying(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to)
    } catch (e: any) {
      if (process.platform !== 'win32' || i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e
      const until = Date.now() + 15 * (i + 1)
      while (Date.now() < until) {
        /* a short synchronous wait: these writes are synchronous by design */
      }
    }
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
