import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dirs, readJson, writeJsonAtomic } from './paths'

// When the app dies without closing its consoles (killed, out of memory, a crash in native code), the
// kernel hangs up their terminals, and a CLI that ignores the hangup keeps running on its own: Gemini
// CLI does, holding ~400 MB and still working on the user's files, and the next launch would resume
// its conversation in a second process. The consoles running are written down, so the next launch
// can end the ones the last one left behind.

interface Entry {
  pid: number
  /** when that process started: a later process given the same pid is not it */
  start: string
  /** an agent CLI, whose whole group goes (a shell's group only while the shell runs: see pty.ts) */
  group?: boolean
}

const recordFile = () => path.join(dirs.root, 'consoles-running.json')

/** A token for when the process started, or null when it is not running (or cannot be told). */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // after the command name, which may hold spaces and parentheses: field 22, starttime
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null
  } catch {
    if (process.platform === 'linux') return null
  }
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || null
  } catch {
    return null
  }
}

const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig)
  } catch {
    /* gone */
  }
}

/** The consoles running now, kept on disk as they start and end. */
export class RunRecord {
  private entries: Record<string, Entry> = {}
  constructor(private file = recordFile()) {}
  add(id: string, pid: number, group = true) {
    const start = processStart(pid)
    if (!start) return
    this.entries[id] = { pid, start, group }
    this.save()
  }
  remove(id: string, pid: number) {
    if (this.entries[id]?.pid !== pid) return
    delete this.entries[id]
    this.save()
  }
  private save() {
    try {
      writeJsonAtomic(this.file, this.entries)
    } catch {
      /* a record that cannot be written only loses this safety net */
    }
  }
}

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/**
 * Whether a recorded console still has processes running: the process itself (the same one: same start),
 * or, when it has ended, others in its process group (a CLI's own children). A pid is not given to a
 * new process while a process group of that id exists, so such a group can only be the console's.
 */
function stillRunning(e: Entry): boolean {
  const start = processStart(e.pid)
  return start !== null ? start === e.start : e.group !== false && groupExists(e.pid)
}

/**
 * End the consoles an earlier run left running: SIGHUP to each one's process group (a console is a
 * session of its own), then SIGKILL to the group for what ignores it. Returns how many there were.
 */
export async function endOrphans(graceMs = 1000, file = recordFile()): Promise<number> {
  const left = Object.values(readJson<Record<string, Entry>>(file, {}) ?? {}).filter((e) => e && Number.isInteger(e.pid) && e.pid > 1 && typeof e.start === 'string' && stillRunning(e))
  for (const e of left) signalGroup(e.pid, 'SIGHUP')
  const until = Date.now() + graceMs
  while (left.some(stillRunning) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  // the whole group: a CLI's own child processes may ignore the hangup even when the CLI did not
  for (const e of left) if (stillRunning(e)) signalGroup(e.pid, 'SIGKILL')
  try {
    writeJsonAtomic(file, {})
  } catch {
    /* nothing to clear */
  }
  return left.length
}
