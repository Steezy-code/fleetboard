import fs from 'node:fs'
import path from 'node:path'
import { dirs } from './paths'

// A stray error in the background (a failed write, a socket that closed early, a rejected promise no one
// awaited) must not stop the app. Electron's default is a modal error box, which holds up this process
// and with it every console's output until someone clicks it. Instead: log it, tell the window.

const LOG = path.join(dirs.root, 'logs', 'main.log')
const MAX_LOG = 1024 * 1024

export function logError(kind: string, err: unknown) {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    // keep it small: start over once it is big
    if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG) fs.renameSync(LOG, LOG + '.1')
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${kind}: ${text}\n`)
  } catch {
    /* nowhere to write: still keep running */
  }
  return text
}

/** message → this minute's count, for logRepeated */
const repeats = new Map<string, { since: number; n: number }>()
const REPEAT_WINDOW_MS = 60_000
/** how many of one message a minute reach the log; the rest are counted */
const REPEAT_LIMIT = 5

/**
 * logError for a source that can repeat itself (the renderer's stray errors: one thrown on every
 * animation frame is sixty a second). Past a few of the same in a minute they are only counted, and
 * the count is written when the minute is up — otherwise they filled the 1 MB log and rotated out the
 * first one, which is the one that says what went wrong.
 */
export function logRepeated(kind: string, message: string, now = Date.now()): boolean {
  const key = `${kind}\0${message.split('\n')[0]}`
  let r = repeats.get(key)
  if (r && now - r.since > REPEAT_WINDOW_MS) {
    if (r.n > REPEAT_LIMIT) logError(kind, `(the error above repeated ${r.n - REPEAT_LIMIT} more times in a minute)`)
    r = undefined
  }
  if (!r) {
    if (repeats.size > 200) repeats.clear()
    r = { since: now, n: 0 }
    repeats.set(key, r)
  }
  r.n++
  if (r.n > REPEAT_LIMIT) return false
  logError(kind, message)
  return true
}

export function catchStrayErrors(tell: (message: string) => void) {
  let lastTold = 0
  const report = (kind: string) => (err: unknown) => {
    const text = logError(kind, err)
    console.error(`${kind}:`, text)
    // one notice at a time is enough; the log has every one
    if (Date.now() - lastTold > 10_000) {
      lastTold = Date.now()
      tell((text.split('\n')[0] ?? '').slice(0, 160))
    }
  }
  process.on('uncaughtException', report('uncaught exception'))
  process.on('unhandledRejection', report('unhandled rejection'))
}
