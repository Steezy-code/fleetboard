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
