import { currentMotion } from './motion'

/** Decorative only: the Ready card and its controls are available throughout. */
export function completionMotion(workers: string[], leadId: string, card: HTMLElement | null) {
  const level = currentMotion()
  if (level === 'off') return () => {}
  const animations: Animation[] = []
  const step = level === 'full' ? Math.min(90, 500 / Math.max(1, workers.length)) : 30
  const duration = level === 'full' ? 550 : 260
  const glow = (element: Element | null, delay: number) => {
    if (!element) return
    animations.push(element.animate([
      { boxShadow: '0 0 0 0 transparent' },
      { boxShadow: '0 0 0 1px var(--ok), 0 0 22px var(--accent-soft)', offset: 0.35 },
      { boxShadow: '0 0 0 0 transparent' }
    ], { duration, delay, easing: 'ease-out' }))
  }
  workers.forEach((id, i) => glow(document.querySelector(`[data-node-id="${CSS.escape(id)}"]`), i * step))
  glow(document.querySelector(`[data-node-id="${CSS.escape(leadId)}"]`), workers.length * step)
  if (card) {
    glow(card, (workers.length + 1) * step)
    animations.push(card.animate([
      { opacity: 0.65, transform: 'translateY(5px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration, delay: (workers.length + 1) * step, easing: 'ease-out', fill: 'backwards' }))
  }
  return () => animations.forEach((animation) => animation.cancel())
}
