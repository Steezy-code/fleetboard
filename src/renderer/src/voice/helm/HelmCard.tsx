import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppWindow, Check, CornerDownLeft, Pencil, Send, Sparkles, Users, Wrench, X, Zap, Lightbulb } from 'lucide-react'
import { useApp } from '../../state/store'
import { playbookById } from '../../playbooks/catalog'
import { PlaybookIcon } from '../../playbooks/PlaybooksView'
import { useVoice } from '../thread'
import { describe } from '../actions'
import { dismissHelm, editHelmOption, type HelmOption, missingInputs, primaryIndex, runHelmOption, useHelm } from './helm'

/** Helm's card above the command bar: the reply and 1-3 one-click routes. */
export function HelmCard() {
  const card = useHelm((s) => s.card)
  const projectId = useApp((s) => s.project?.id)
  // re-measure whenever the caption below may have changed
  const phase = useVoice((s) => s.phase)
  const pending = useVoice((s) => !!s.pending)
  const until = useVoice((s) => s.captionUntil)
  const capReply = useVoice((s) => s.reply)
  const [bottom, setBottom] = useState(150)
  const [hover, setHover] = useState(false)
  const [, tick] = useState(0)
  const firstProject = useRef(projectId)

  // a different project: the card no longer applies
  useEffect(() => {
    if (projectId !== firstProject.current) {
      firstProject.current = projectId
      dismissHelm()
    }
  }, [projectId])

  // sit above the caption when it shows, else just above the bottom bar
  useLayoutEffect(() => {
    if (!card) return
    const measure = () => {
      const cap = document.querySelector('.voice-caption') as HTMLElement | null
      const bar = document.querySelector('.bottombar') as HTMLElement | null
      const top = cap ? cap.getBoundingClientRect().top : bar ? bar.getBoundingClientRect().top : window.innerHeight - 140
      setBottom(Math.round(window.innerHeight - top + 10))
    }
    measure()
    const raf = requestAnimationFrame(measure)
    const cap = document.querySelector('.voice-caption') as HTMLElement | null
    const ro = cap ? new ResizeObserver(measure) : null
    if (cap) ro!.observe(cap)
    const ms = until - Date.now()
    const t = ms > 0 ? window.setTimeout(() => tick((n) => n + 1), ms + 40) : 0
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.clearTimeout(t)
      window.removeEventListener('resize', measure)
    }
  })

  // Esc dismisses (not while typing in a console or a dialog is up)
  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const app = useApp.getState()
      if (app.panel || app.confirms.length) return
      const el = e.target as HTMLElement | null
      const typing = !!el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [data-terminal], webview')
      if (typing && !el?.classList.contains('command-input')) return
      dismissHelm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card])

  // nothing left to click (an answer, or the only route already ran): fade out after a while
  const primary = primaryIndex(card)
  useEffect(() => {
    if (!card || primary != null || hover) return
    const t = window.setTimeout(() => {
      if (useHelm.getState().card?.id === card.id) dismissHelm()
    }, 15000)
    return () => window.clearTimeout(t)
  }, [card, primary, hover])

  void phase
  void pending
  void capReply
  if (!card) return null

  return (
    <div
      className="helm-card"
      style={{ bottom }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="helm-head">
        <span className="helm-mark">
          <Sparkles size={13} />
        </span>
        <span className="helm-name">Oracle</span>
        <span className="helm-req" title={card.request}>
          “{card.request}”
        </span>
        <button className="icon-btn helm-x" title="Dismiss (Esc)" onClick={dismissHelm}>
          <X size={13} />
        </button>
      </div>
      <div className="helm-reply">{card.reply || 'Here are the routes I see.'}</div>
      {card.options.length > 0 && (
        <div className="helm-options">
          {card.options.map((o, i) => (
            <OptionRow key={i} o={o} i={i} primary={i === primary} ran={i === card.ran} />
          ))}
        </div>
      )}
      <div className="helm-foot">
        {primary != null && (
          <button className="helm-link" onClick={() => editHelmOption(primary)} title="Put this back in the command bar to change it">
            Edit
          </button>
        )}
        <span className="grow" />
        {primary != null && (
          <span className="helm-hint">
            <kbd>Enter</kbd> runs the first
          </span>
        )}
        <span className="helm-hint">
          <kbd>Esc</kbd> dismisses
        </span>
      </div>
    </div>
  )
}

function OptionRow({ o, i, primary, ran }: { o: HelmOption; i: number; primary: boolean; ran: boolean }) {
  const missing = o.kind === 'playbook' ? missingInputs(o) : []
  const detail = o.detail || (missing.length ? `Needs: ${missing.map((m) => m.label).join(', ')}` : '')
  const title = o.kind === 'actions' ? o.actions!.filter((a) => a.type !== 'say').map(describe).join(' → ') : o.kind === 'send' ? `${o.submit === false ? 'Type' : 'Send'} to ${o.targets!.join(', ')}: ${o.text}` : o.kind === 'team' ? o.goal : detail
  const editable = o.kind === 'team' || o.kind === 'send'
  return (
    <div className={`helm-opt ${primary ? 'primary' : ''} ${ran ? 'ran' : ''}`}>
      <button className="helm-opt-main" disabled={ran} title={title} onClick={() => runHelmOption(i)}>
        <span className="helm-opt-icon">{ran ? <Check size={14} /> : <KindIcon o={o} />}</span>
        <span className="helm-opt-text">
          <span className="helm-opt-label">
            {o.label}
            {ran && <span className="helm-ran">done</span>}
            {missing.length > 0 && <span className="helm-ran">fill in first</span>}
          </span>
          {detail && <span className="helm-opt-detail">{detail}</span>}
        </span>
        {primary && (
          <span className="helm-enter" title="Enter in the empty command bar">
            <CornerDownLeft size={12} />
          </span>
        )}
      </button>
      {editable && !ran && (
        <button className="icon-btn helm-edit" title="Edit in the command bar" onClick={() => editHelmOption(i)}>
          <Pencil size={12} />
        </button>
      )}
    </div>
  )
}

function KindIcon({ o }: { o: HelmOption }) {
  switch (o.kind) {
    case 'playbook':
      return <PlaybookIcon name={playbookById(o.playbook!.id)?.icon ?? 'Rocket'} size={14} />
    case 'team':
      return <Users size={14} />
    case 'send':
      return <Send size={14} />
    case 'actions':
      return <Zap size={14} />
    case 'panel':
      return <AppWindow size={14} />
    case 'github':
      return <Wrench size={14} />
    case 'brainstorm':
      return <Lightbulb size={14} />
    default:
      return <Sparkles size={14} />
  }
}
