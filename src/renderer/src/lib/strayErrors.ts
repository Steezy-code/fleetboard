import { fb } from './api'
import { useApp } from '../state/store'

/**
 * Stray errors in the window: the renderer half of main's catchStrayErrors.
 *
 * React's error boundaries only see a crash *during render*. A rejected promise in an event handler,
 * a worker that fails to load its model, a listener that throws after the tree has rendered — none
 * of those reach a boundary, so until now they appeared nowhere at all: no toast, no log, nothing to
 * tell a user why speech went quiet or a panel stopped updating.
 *
 * Same shape as main/errors.ts: log every one, tell the user about one at a time.
 */
export function catchStrayErrors() {
  let lastTold = 0
  const report = (kind: string, detail: unknown) => {
    const text = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
    console.error(`${kind}:`, text)
    try {
      fb.send('app:logError', `${kind}: ${text}`)
    } catch {
      /* the bridge is the one thing that cannot report its own failure */
    }
    // one notice at a time is enough; the log has every one
    if (Date.now() - lastTold < 10_000) return
    lastTold = Date.now()
    try {
      useApp.getState().toast(`Something went wrong in the window: ${text.split('\n')[0].slice(0, 160)}`, 'warn')
    } catch {
      /* the store itself is broken: the log and the console still have it */
    }
  }

  window.addEventListener('error', (e) => {
    // a failed <img>/<script> load also fires this, with no error object: not worth a toast
    if (!e.error && !e.message) return
    report('uncaught exception', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason))
}
