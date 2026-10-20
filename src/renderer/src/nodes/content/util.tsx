import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

/** Close a popover/menu when the pointer goes down outside of it (or Escape is pressed). */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cb.current()
      }
    }
    // defer so the opening click does not immediately close it
    const t = window.setTimeout(() => {
      window.addEventListener('pointerdown', down, true)
      window.addEventListener('keydown', key, true)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, ref])
}

/**
 * Toolbar that floats above a chromeless node and keeps a constant on-screen size whatever the zoom.
 */
export function FloatBar({ zoom, children, className = '' }: { zoom: number; children: ReactNode; className?: string }) {
  const s = 1 / Math.max(0.2, zoom)
  return (
    <div
      className={`float-bar ${className}`}
      style={{ transform: `scale(${s})` }}
      onPointerDown={(e) => e.stopPropagation()}
      // keep focus in the node being edited while styling it (inputs still take focus)
      onMouseDown={(e) => !(e.target as HTMLElement).closest('input') && e.preventDefault()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

// ---------- dates ----------
export const pad2 = (n: number) => String(n).padStart(2, '0')
export const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
export const todayYmd = () => ymd(new Date())
export const parseYmd = (s: string) => {
  const [y = 1970, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const shortDate = (s: string) => {
  const d = parseYmd(s)
  const now = new Date()
  const base = `${(MONTHS[d.getMonth()] ?? '').slice(0, 3)} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}
/** Today / Tomorrow / Yesterday / "Sep 14" plus whether it is in the past. */
export function dueInfo(s: string): { label: string; tone: 'today' | 'soon' | 'past' | 'later' } {
  const t = todayYmd()
  if (s === t) return { label: 'Today', tone: 'today' }
  if (s === ymd(addDays(new Date(), 1))) return { label: 'Tomorrow', tone: 'soon' }
  if (s === ymd(addDays(new Date(), -1))) return { label: 'Yesterday', tone: 'past' }
  return { label: shortDate(s), tone: s < t ? 'past' : 'later' }
}
/** "14:30" → "2:30pm" */
export const fmtTime = (t?: string) => {
  if (!t) return ''
  const [h = 0, m] = t.split(':').map(Number)
  const hh = h % 12 || 12
  return `${hh}${m ? ':' + pad2(m) : ''}${h < 12 ? 'am' : 'pm'}`
}
