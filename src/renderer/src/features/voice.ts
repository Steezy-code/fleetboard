// Voice feature entry: push-to-talk keys, caption + Helm card overlays, thread persistence, console activity tracking.
import '../styles/voice.css'
import '../styles/helm.css'
import { BOARD_OVERLAYS } from '../board/BoardOverlays'
import { registerEngine } from '../engine/engines'
import { on } from '../lib/api'
import { useApp } from '../state/store'
import { Caption } from '../voice/Caption'
import { HelmCard } from '../voice/helm/HelmCard'
import { markActive } from '../voice/actions'
import { beginListening, cancelListening, endListening, isListening } from '../voice/stt'
import { hydrateThread } from '../voice/thread'

BOARD_OVERLAYS.push(Caption, HelmCard)

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [data-terminal], webview')
}

/** Which key started the current push-to-talk (null when not held). */
let held: 'space' | 'alt' | null = null

function onKeyDown(e: KeyboardEvent) {
  if (held && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    held = null
    cancelListening()
    return
  }
  if (e.code !== 'Space') return
  const app = useApp.getState()
  if (!app.project) return
  const alt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
  const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
  let ok = false
  if (alt) ok = true
  else if (plain && app.settings.pushToTalkKey !== 'AltSpace') {
    // plain Space only on the board itself: not while typing or with a dialog open
    ok = !isTyping(e.target) && !isTyping(document.activeElement) && !app.panel && !app.confirms.length
  }
  if (!ok && !held) return
  e.preventDefault()
  e.stopPropagation()
  if (e.repeat || held) return
  held = alt ? 'alt' : 'space'
  beginListening()
}

function onKeyUp(e: KeyboardEvent) {
  if (!held || e.code !== 'Space') return
  e.preventDefault()
  e.stopPropagation()
  held = null
  endListening()
}

registerEngine(() => {
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', () => {
    if (held && isListening()) endListening()
    held = null
  })
  // "this" = the console that printed most recently
  on('pty:data', (id: string) => markActive(id))
  // thread follows the open project
  hydrateThread()
  let lastId = useApp.getState().project?.id
  useApp.subscribe((s) => {
    const id = s.project?.id
    if (id !== lastId) {
      lastId = id
      hydrateThread()
    }
  })
})
