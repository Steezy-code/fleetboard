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
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
