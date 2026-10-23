import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { Lightbulb } from 'lucide-react'
import { invoke } from '../lib/api'

// A line of explanation the first time something happens: the first question in the Inbox, the
// first finished team, the first time a tile fills the screen. Shown where it happens rather than in
// a tour up front, because the moment you need to know what Tab does in the Inbox is the moment a
// card is in it. Each is shown once, ever: dismissed with "Got it", or taken as read once it has
// been on screen a few seconds and the thing it explained goes away.

export type TipId = 'inbox' | 'ready' | 'focus'

const KEY = 'tipsSeen'
/** long enough to have been read, short enough that a tip seen in passing still counts */
const READ_MS = 4000

const useTips = create<{ seen: Partial<Record<TipId, true>> | null }>(() => ({ seen: null }))

let loading = false

/** Read which tips were seen, once; until it answers no tip shows, so none flashes up on a reload. */
function load() {
  if (loading) return
  loading = true
  invoke<Partial<Record<TipId, true>>>('store:getGlobal', KEY).then(
    (s) => useTips.setState((cur) => ({ seen: { ...(s && typeof s === 'object' ? s : {}), ...cur.seen } })),
    () => useTips.setState((cur) => ({ seen: cur.seen ?? {} }))
  )
}

export function seeTip(id: TipId) {
  const seen = { ...useTips.getState().seen, [id]: true as const }
  useTips.setState({ seen })
  void invoke('store:setGlobal', KEY, seen).catch(() => undefined)
}

/** Whether a tip is still to be shown; false until the record of seen tips has loaded. */
export function useTipDue(id: TipId): boolean {
  useEffect(load, [])
  return useTips((s) => !!s.seen && !s.seen[id])
}

export function Tip({ id, children }: { id: TipId; children: React.ReactNode }) {
  const due = useTipDue(id)
  const shownAt = useRef(0)
  useEffect(() => {
    if (!due) return
    shownAt.current = Date.now()
    return () => {
      if (Date.now() - shownAt.current >= READ_MS) seeTip(id)
    }
  }, [due, id])
  if (!due) return null
  return (
    <div className="tip" data-tip={id} onPointerDown={(e) => e.stopPropagation()}>
      <Lightbulb size={13} className="tip-icon" />
      <span className="tip-text">{children}</span>
      <button className="btn sm ghost" onClick={() => seeTip(id)}>
        Got it
      </button>
    </div>
  )
}
