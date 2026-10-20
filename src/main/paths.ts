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

/** Write JSON atomically so a crash mid-write never corrupts state. `mode` 0o600 for files only the user may read. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode })
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  renameRetrying(tmp, file)
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
