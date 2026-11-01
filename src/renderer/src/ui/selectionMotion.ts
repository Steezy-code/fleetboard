import { currentMotion } from './motion'
import { eventDuration } from '@shared/motion'

/**
 * A second item joining a selection: the frames that are now in it are acknowledged once.
 *
 * Decorative only — the shared boundary around the set is drawn by the board and stays for as long
 * as the selection does, with or without this.
 */
export function selectionPulse(ids: readonly string[]) {
  const level = currentMotion()
  if (level === 'off' || ids.length < 2) return () => {}
  const duration = eventDuration(level)
  const bright = level === 'full'
  const animations: Animation[] = []
  for (const id of ids) {
    const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"], [data-group-id="${CSS.escape(id)}"]`)
    if (!el) continue
    animations.push(
      el.animate(
        [
          { outline: '0px solid transparent', outlineOffset: '2px' },
          { outline: `${bright ? 3 : 2}px solid var(--accent)`, outlineOffset: '3px', offset: 0.4 },
          { outline: '0px solid transparent', outlineOffset: '2px' }
        ],
        { duration, easing: 'ease-out' }
      )
    )
  }
  return () => animations.forEach((a) => a.cancel())
}
