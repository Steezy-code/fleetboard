// Feature module entry: board content (planning nodes) and ink. Registers the ink style toolbar overlay,
// a couple of ink keyboard shortcuts and the content stylesheet.
import { isTypingTarget } from '../lib/typing'
import { BOARD_OVERLAYS } from '../board/BoardOverlays'
import { InkToolbar } from '../board/ink/InkToolbar'
import { duplicateInk, selectedInk, useInkUi } from '../board/ink/inkState'
import { useApp } from '../state/store'
import '../styles/content.css'

// (idempotent so Vite HMR re-running this module does not stack duplicates)
const prev = BOARD_OVERLAYS.findIndex((c) => (c as any).__fbInk)
if (prev >= 0) BOARD_OVERLAYS.splice(prev, 1)
;(InkToolbar as any).__fbInk = true
BOARD_OVERLAYS.push(InkToolbar)

const typing = isTypingTarget

function onKey(e: KeyboardEvent) {
  if (typing(e.target) || !useApp.getState().project) return
  const mod = e.ctrlKey || e.metaKey
  const sel = selectedInk()
  if (!sel.length) return
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    duplicateInk(sel)
  } else if (e.key === 'Enter' && sel.length === 1) {
    const only = sel[0]
    if (!only || only.kind === 'path') return
    e.preventDefault()
    useInkUi.setState({ editing: only.id })
  }
}

const w = window as any
if (w.__fbInkKeys) window.removeEventListener('keydown', w.__fbInkKeys)
w.__fbInkKeys = onKey
window.addEventListener('keydown', onKey)
