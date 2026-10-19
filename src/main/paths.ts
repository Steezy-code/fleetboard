import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const ROOT = path.join(os.homedir(), '.fleetboard')
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

/** Write JSON atomically so a crash mid-write never corrupts state. */
export function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
