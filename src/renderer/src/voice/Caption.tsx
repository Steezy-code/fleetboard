import { useApp } from '../state/store'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useVoice } from './thread'
import { cancelPending, confirmPending } from './planner'
import { useAsciiReveal } from 'ascii-reveal'

/** Caption bubble above the command bar: live / final transcript, reply, and plans waiting for "confirm". */
export function Caption() {
  const plan = useAsciiReveal({ preset: 'terminal' })
  const phase = useVoice((s) => s.phase)
  const transcript = useVoice((s) => s.transcript)
  const reply = useVoice((s) => s.reply)
  const until = useVoice((s) => s.captionUntil)
  const pending = useVoice((s) => s.pending)
  const [, tick] = useState(0)
  const [bottom, setBottom] = useState(150)

  // hide once the reply has been shown long enough
  useEffect(() => {
    const ms = until - Date.now()
    if (ms <= 0) return
    const t = window.setTimeout(() => tick((n) => n + 1), ms + 20)
    return () => window.clearTimeout(t)
  }, [until])

  const visible = phase !== 'idle' || !!pending || Date.now() < until

  // sit just above the bottom bar (chips + hint), whatever its height
  useLayoutEffect(() => {
    if (!visible) return
    const measure = () => {
      const bar = document.querySelector('.bottombar') as HTMLElement | null
      if (bar) setBottom(window.innerHeight - bar.getBoundingClientRect().top + 10)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [visible])

  if (!visible) return null
  const listening = phase === 'listening'

  return (
    <div className="voice-caption" style={{ bottom }} onPointerDown={(e) => e.stopPropagation()}>
      {transcript ? (
        <div className={`vc-user ${listening ? 'live' : ''}`}>“{transcript}”</div>
      ) : listening ? (
        <div className="vc-user placeholder">Listening… release to send</div>
      ) : null}
      {phase === 'thinking' && (
        <div className="vc-reply">
          <span className="orb sm thinking" />
          <span className="cb-shimmer">{useApp.getState().settings.helm !== false ? 'Oracle is reading the board…' : 'Planning with your CLI…'}</span>
        </div>
      )}
      {pending ? (
        <div className="vc-plan" ref={plan.ref}>
          <div className="vc-plan-title">Plan · waiting for confirm</div>
          {pending.steps.length > 0 && (
            <ol>
              {pending.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
          <div className="vc-prompt">{pending.prompt}</div>
          <div className="vc-actions">
            <button className="btn primary" onClick={() => confirmPending()}>
              Confirm
            </button>
            <button className="btn" onClick={() => cancelPending()}>
              Cancel
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              or say “confirm” / “cancel”
            </span>
          </div>
        </div>
      ) : (
        reply &&
        phase !== 'listening' && (
          <div className="vc-reply">
            <span className="orb sm" />
            <span>{reply}</span>
          </div>
        )
      )}
    </div>
  )
}
