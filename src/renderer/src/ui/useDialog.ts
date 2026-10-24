import { useEffect, useRef } from 'react'

const dialogs: HTMLElement[] = []
const candidates = 'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'

/** The top dialog owns focus and Escape; closing it returns focus to its invoker. */
export function useDialog(close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close }, [close])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogs.push(el)
    const controls = () => Array.from(el.querySelectorAll<HTMLElement>(candidates)).filter((x) => !x.matches(':disabled') && !x.closest('[inert]') && x.getClientRects().length > 0)
    const focus = () => (controls()[0] ?? el).focus()
    focus()
    const key = (e: KeyboardEvent) => {
      if (dialogs.at(-1) !== el) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); closeRef.current()
      } else if (e.key === 'Tab') {
        const list = controls()
        const first = list[0] ?? el
        const last = list.at(-1) ?? el
        if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
          e.preventDefault(); last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
          e.preventDefault(); first.focus()
        }
      }
    }
    const contain = (e: FocusEvent) => {
      if (dialogs.at(-1) === el && !el.contains(e.target as Node)) focus()
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('focusin', contain)
    return () => {
      dialogs.splice(dialogs.indexOf(el), 1)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('focusin', contain)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return ref
}
