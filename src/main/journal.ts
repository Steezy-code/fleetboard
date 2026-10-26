import fs from 'node:fs'
import path from 'node:path'
import type { MainContext } from './context'
import { dirs } from './paths'
import { logError } from './errors'
import { dayKey } from '@shared/time'

// What happened while nobody was watching.
//
// Loops type into consoles on a schedule or whenever one goes idle, the CI watcher spawns a fixer
// console when a run goes red, a team merges branches and removes worktrees, and the phone Inbox can
// answer an agent's question from anywhere. All of that reported itself through toasts, which live
// 4200 ms — so a night of unattended work left no trace beyond its consequences. This is the trace.
//
// One line per event, appended. The line is the point: the question this exists to answer is "what did
// it do while I was asleep, and what did it say yes to on my behalf", and that has to be readable in
// one pass. `kind` is for filtering, `detail` for when the line is not enough.
//
// Shaped after errors.ts, which is the same problem solved for stray errors: append, cap, rotate, and
// never let a failure to write stop the thing being recorded.

export interface JournalEntry {
  at: number
  /** area.event, e.g. loop.fire, prompt.answer, guard.ceiling */
  kind: string
  /** one line, for a person reading the night back */
  text: string
  project?: string
  detail?: Record<string, unknown>
}

const DIR = path.join(dirs.root, 'journal')
const MAX_BYTES = 2 * 1024 * 1024
const KEEP_DAYS = 30
const MAX_TEXT = 500
const MAX_DETAIL = 2000

const fileFor = (at: number) => path.join(DIR, `${dayKey(at)}.jsonl`)

/**
 * A day's file past its size goes aside as the next free `.N`, so a busy day keeps all of it: it used
 * to be renamed over `.1`, and a second rotation the same day threw the first one away. Checked on
 * every append (a stat it makes anyway): once an hour let a burst run far past the limit.
 */
function rotate(file: string) {
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) <= MAX_BYTES) return
  let n = 1
  while (fs.existsSync(`${file}.${n}`)) n++
  fs.renameSync(file, `${file}.${n}`)
}

/** A day's parts, newest first: the file being written, then what was set aside, last first. */
function partsOf(file: string): string[] {
  const base = path.basename(file)
  let names: string[] = []
  try {
    names = fs.readdirSync(DIR)
  } catch {
    return [file]
  }
  const rotated = names
    .map((n) => (n.startsWith(base + '.') ? Number(n.slice(base.length + 1)) : NaN))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a)
  return [file, ...rotated.map((n) => `${file}.${n}`)]
}

/** Forget whole days that are old enough. */
function tidy() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000
  for (const name of fs.readdirSync(DIR)) {
    const day = /^(\d{4})-(\d{2})-(\d{2})\.jsonl(\.\d+)?$/.exec(name)
    if (!day) continue
    if (new Date(`${day[1]}-${day[2]}-${day[3]}T23:59:59`).getTime() < cutoff) fs.rmSync(path.join(DIR, name), { force: true })
  }
}

let lastTidy = 0

/**
 * A crash mid-append can leave a line with no newline at the end of the file, and the next append
 * would then run into it and lose itself as well. One torn line should cost one entry. A stat and a
 * one-byte read per entry, which at a few entries a minute is nothing worth optimising away.
 */
function startsOnItsOwnLine(file: string): string {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (!size) return ''
  const fd = fs.openSync(file, 'r')
  try {
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a ? '' : '\n'
  } finally {
    fs.closeSync(fd)
  }
}

/** Record something that happened. Never throws: a journal that breaks the app is worse than none. */
export function append(entry: Omit<JournalEntry, 'at'> & { at?: number }): void {
  const at = entry.at ?? Date.now()
  const line: JournalEntry = {
    at,
    kind: String(entry.kind).slice(0, 60),
    text: String(entry.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  }
  if (entry.project) line.project = String(entry.project).slice(0, 200)
  try {
    if (entry.detail) {
      // bounded, because some of this comes from the renderer and some of it from a model's output;
      // and inside the try, because a detail JSON cannot write (a cycle, a BigInt) must cost the detail,
      // not the entry, and never throw out of here
      const json = JSON.stringify(entry.detail)
      if (json && json.length <= MAX_DETAIL) line.detail = entry.detail
    }
  } catch {
    /* no detail, then */
  }
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const file = fileFor(at)
    rotate(file)
    // once an hour is enough: this runs on a path that can fire several times a minute
    if (Date.now() - lastTidy > 3_600_000) {
      lastTidy = Date.now()
      tidy()
    }
    fs.appendFileSync(file, startsOnItsOwnLine(file) + JSON.stringify(line) + '\n')
  } catch (e) {
    logError('journal', e)
  }
}

/** The most recent entries, newest first. */
export function read(opts: { days?: number; limit?: number } = {}): JournalEntry[] {
  const days = Math.max(1, Math.min(KEEP_DAYS, opts.days ?? 3))
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500))
  const out: JournalEntry[] = []
  for (let i = 0; i < days && out.length < limit; i++) {
    for (const file of partsOf(fileFor(Date.now() - i * 86_400_000))) {
      if (out.length >= limit) break
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue // no such day
      }
      for (const l of text.split('\n').reverse()) {
        if (!l.trim() || out.length >= limit) continue
        try {
          const e = JSON.parse(l) as JournalEntry
          if (typeof e?.at === 'number' && typeof e?.text === 'string') out.push(e)
        } catch {
          /* a line torn by a crash mid-append: the rest of the day is still readable */
        }
      }
    }
  }
  return out
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('journal:append', (_e, entry: Omit<JournalEntry, 'at'>) => append(entry))
  ctx.ipc.handle('journal:read', (_e, opts?: { days?: number; limit?: number }) => read(opts ?? {}))
  ctx.ipc.handle('journal:dir', () => DIR)

  // a console starting and ending is the frame everything else sits in
  ctx.ptys.onSpawn((req) => append({ kind: 'console.start', text: `${req.agentId} started in ${req.cwd}`, detail: { id: req.id, agentId: req.agentId, resume: !!req.resume } }))
  ctx.ptys.onExit((id, code, appClosing) => {
    // quitting ends every console at once: that is not news, and it would bury the night
    if (appClosing) return
    append({ kind: 'console.exit', text: code === 0 ? `a console ended normally` : `a console ended with exit ${code ?? 'unknown'}`, detail: { id, code } })
  })
}

/** A prompt answered on the user's behalf: the entry that matters most for trusting the rest. */
export const answered = (by: string, consoleId: string, what: string) =>
  append({ kind: 'prompt.answer', text: `${by} answered "${what}"`, detail: { consoleId, by } })
