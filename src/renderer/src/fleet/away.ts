import { useEffect } from 'react'
import { create } from 'zustand'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { useFleet } from '../engine/fleet'
import { awaySummary, span, type JournalLine } from './awaySummary'
import type { InboxItem } from './inboxModel'

// Noticing that you left and came back, so the Inbox can open with what happened meanwhile
// (awaySummary.ts) instead of leaving you to piece it together from the board.
//
// Away is either of two things. The window lost focus: you went to an editor, a browser, another
// desk. Or it kept focus but nobody touched the computer: the screen locked, the night passed. The
// first comes from the window's own blur and focus; the second from the system's idle time, asked of
// the main process once a minute while the window is in front. Back is focus, or the first key or
// pointer movement after idling. Ten minutes is the threshold: less than that, the board in front
// of you is still the summary.

const AWAY_MS = 10 * 60_000
const IDLE_POLL_MS = 60_000

interface Away {
  /** when you left; null while you are here */
  since: number | null
  /** the card, until it is read */
  summary: { since: number; back: number; lines: string[] } | null
}

export const useAway = create<Away>(() => ({ since: null, summary: null }))

function leave(at: number) {
  const { since } = useAway.getState()
  if (since === null || at < since) useAway.setState({ since: at })
}

async function back() {
  const { since } = useAway.getState()
  if (since === null) return
  useAway.setState({ since: null })
  const now = Date.now()
  if (now - since < AWAY_MS) return
  const project = useApp.getState().project?.path
  const days = Math.ceil((now - since) / 86_400_000) + 1
  const entries = await invoke<JournalLine[]>('journal:read', { days, limit: 2000 }).catch((): JournalLine[] => [])
  // the journal is app-wide: another project's loops and merges are not news about this board
  const here = entries.filter((e) => !e.project || e.project === project)
  const lines = awaySummary({ since, entries: here, fleet: useFleet.getState().state })
  if (lines.length) useAway.setState({ summary: { since, back: now, lines } })
}

/** The Inbox card for the last time you were away, if anything happened. */
export function awayItem(): InboxItem | null {
  const s = useAway.getState().summary
  if (!s) return null
  const from = new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return {
    kind: 'notice',
    tone: 'info',
    key: `away:${s.since}`,
    who: 'While you were away',
    sub: `${span(s.back - s.since)}, from ${from}`,
    head: '',
    lines: s.lines,
    since: s.back,
    actions: [
      { label: 'Got it', primary: true, run: () => useAway.setState({ summary: null }) },
      { label: 'Night log', keeps: true, run: () => useApp.getState().openDrawer('journal', {}) }
    ]
  }
}

/** Mounted once, with the Inbox. */
export function useAwayWatcher() {
  useEffect(() => {
    const onBlur = () => {
      const at = Date.now()
      // focus moving into a web tile blurs the window too, though you never left it
      window.setTimeout(() => !document.hasFocus() && leave(at), 0)
    }
    const onBack = () => {
      if (useAway.getState().since !== null && document.hasFocus()) void back()
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onBack)
    for (const e of ['keydown', 'pointerdown', 'pointermove'] as const) window.addEventListener(e, onBack, true)
    const t = window.setInterval(async () => {
      if (!document.hasFocus() || useAway.getState().since !== null) return
      const idle = await invoke<number>('app:idleSeconds').catch(() => 0)
      if (idle * 1000 >= AWAY_MS) leave(Date.now() - idle * 1000)
    }, IDLE_POLL_MS)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onBack)
      for (const e of ['keydown', 'pointerdown', 'pointermove'] as const) window.removeEventListener(e, onBack, true)
      window.clearInterval(t)
    }
  }, [])
}
