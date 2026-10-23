import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { driftOf, type Drift } from '@shared/drift'
import { useFleet } from '../engine/fleet'
import { useApp } from '../state/store'
import { useNow } from '../lib/useNow'
import { openConsole } from './inboxModel'

// Oracle's ambient line, above the Inbox tray: one sentence, composed locally (shared/drift.ts), only
// when live work drifts from its charter. It asks nothing, which is why it is not an Inbox item: the
// Inbox is for answers. Badged Oracle because it reads what Oracle reads, not because a model wrote it.

/**
 * Dismissed drifts, by key. A key names one occurrence (this silence, this run), so the next one
 * still shows.
 *
 * ponytail: in memory, so a reload can show a dismissed line once more. Keep it with the project only
 * if that turns out to be noise.
 */
const dismissed = new Set<string>()

export function AmbientLine() {
  const fleet = useFleet((s) => s.state)
  const live = useApp((s) => s.live)
  // the tick only says when to look again; the time is read when it looks, so a team that just
  // changed is measured now, not at the last tick
  const tick = useNow(30_000)
  const [drift, setDrift] = useState<Drift | null>(null)
  const look = () => setDrift(driftOf(fleet, Date.now(), { live: (id) => !!live[id], dismissed }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(look, [fleet, live, tick])
  if (!drift) return null
  return (
    <div className="ambient-line" data-kind={drift.kind} role="status">
      <span className="ambient-badge">
        <Sparkles size={11} /> Oracle
      </span>
      <span className="ambient-text" title={drift.text}>
        {drift.text}
      </span>
      {drift.consoleId && (
        <button className="ambient-btn" onClick={() => openConsole(drift.consoleId!)}>
          Open
        </button>
      )}
      <button
        className="icon-btn sm"
        title="Dismiss"
        onClick={() => {
          dismissed.add(drift.key)
          look()
        }}
      >
        <X size={12} />
      </button>
    </div>
  )
}
