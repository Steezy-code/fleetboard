import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, CornerDownRight, Mic, Sparkles, Square } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ROLE_TINT, type ConsoleStatus } from '@shared/types'
import { activeWs, allConsoles, useApp } from '../state/store'
import { agentColor, agentLabel } from '../engine/consoles'
import { STATUS_TEXT } from '../orchestration/fleet'
import { norm } from './actions'
import { cancelPending, runCommand } from './planner'
import { cancelListening, toggleListening } from './stt'
import { stopSpeaking } from './tts'
import { useThread, useVoice } from './thread'
import { primaryIndex, runHelmOption, useHelm } from './helm/helm'
import { cycleFront, frontItem, runAction, settled, toggleInbox, useInbox } from '../fleet/inboxModel'

// Bottom command bar: orb · input (@mentions) · ^ thread · stop · Helm toggle · mic.
// Hold Space (outside inputs/terminals) or Alt+Space anywhere to talk; Enter submits typed text.

export function stopEverything() {
  cancelListening()
  useVoice.getState().cancelThinking?.()
  stopSpeaking()
}

export function CommandBar() {
  const phase = useVoice((s) => s.phase)
  const speaking = useVoice((s) => s.speaking)
  const download = useVoice((s) => s.download)
  const chatOpen = useApp((s) => s.drawer?.name === 'chat')
  const helm = useApp((s) => s.settings.helm !== false)
  const helmThinking = useHelm((s) => s.thinking)
  const busy = phase !== 'idle' || speaking
  // a question or finished work in front of the Inbox: typed text answers that agent
  const replyTo = useInbox((s) => {
    const f = s.items.find((i) => i.key === s.front) ?? s.items[0]
    return f?.replyTo?.label ?? null
  })
  const orbClass = phase === 'listening' ? 'listening' : phase === 'thinking' || phase === 'transcribing' ? 'thinking' : speaking ? 'speaking' : ''

  return (
    <div className={`command-bar ${phase === 'listening' ? 'listening' : ''}`}>
      <span className={`orb ${orbClass}`} title={speaking ? 'Speaking' : undefined} />
      <div className="cb-main">
        {phase === 'listening' ? (
          <div className="cb-listening">
            <span className="rec" />
            <span>listening</span>
            <Meter />
            {download?.what === 'speech' && <span className="cb-sub">{downloadText(download.label, download.pct)}</span>}
          </div>
        ) : phase === 'transcribing' ? (
          <div className="cb-shimmer">{download?.what === 'speech' ? downloadText(download.label, download.pct) : 'Transcribing…'}</div>
        ) : phase === 'thinking' ? (
          <div className="cb-shimmer">{helmThinking ? 'Oracle is reading the board…' : 'Thinking…'}</div>
        ) : null}
        {/* stays mounted so a half-typed command survives a listen */}
        <div className="cb-input" style={phase === 'idle' ? undefined : { display: 'none' }}>
          {replyTo && (
            <span className="cb-reply" title={`What you type goes to ${replyTo}`}>
              <CornerDownRight size={12} /> {replyTo}
            </span>
          )}
          <CommandInput primary placeholder={replyTo ? `Answer ${replyTo} in your own words…` : helm ? 'Ask Oracle, or say "brainstorm …"' : 'Hold space to speak · @ to direct…'} />
        </div>
      </div>
      {phase === 'idle' && download && <span className="cb-sub">{downloadText(download.label, download.pct)}</span>}
      <button
        className={`icon-btn ${chatOpen ? 'on' : ''}`}
        title="Thread"
        onClick={() => (chatOpen ? useApp.getState().closeDrawer() : useApp.getState().openDrawer('chat'))}
      >
        <ChevronUp size={15} style={{ transform: chatOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {busy && (
        <button className="icon-btn stop" title="Stop" onClick={stopEverything}>
          <Square size={13} fill="currentColor" />
        </button>
      )}
      <button
        className={`icon-btn helm-toggle ${helm ? 'on' : ''}`}
        title={helm ? 'Oracle: reads the board, answers, suggests the best route and brainstorms (click to turn off)' : 'Oracle is off: requests go straight to the Lead or the planner (click to turn on)'}
        aria-pressed={helm}
        onClick={() => useApp.getState().setSettings({ helm: !helm })}
      >
        <Sparkles size={15} />
      </button>
      <button
        className={`icon-btn ${phase === 'listening' ? 'mic-on' : ''}`}
        title={phase === 'listening' ? 'Stop listening' : 'Talk (hold Space)'}
        onClick={toggleListening}
      >
        <Mic size={15} />
      </button>
      {download && (
        <div className={`cb-progress ${download.pct == null ? 'indeterminate' : ''}`}>
          <i style={{ width: `${download.pct ?? 0}%` }} />
        </div>
      )}
    </div>
  )
}

const downloadText = (label: string, pct: number | null) => (pct == null ? `${label}…` : `${label}… ${pct}%`)

/** Level meter driven by mic RMS. */
function Meter() {
  const level = useVoice((s) => s.level)
  const shape = [0.45, 0.8, 1, 0.7, 0.4]
  return (
    <span className="cb-meter">
      {shape.map((k, i) => (
        <i key={i} style={{ height: `${4 + Math.min(1, level * k * (0.85 + ((i * 37) % 10) / 30)) * 18}px` }} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- input with @mentions + history

interface MentionOption {
  key: string
  token: string
  label: string
  meta: string
  color?: string
  team?: boolean
  status?: ConsoleStatus
}

function useMentionOptions(query: string | null): MentionOption[] {
  // re-derive when names / teams / statuses change
  const sig = useApp(
    useShallow((s) => {
      if (query == null) return ''
      const p = s.project
      if (!p) return ''
      return p.workspaces
        .map((w) => w.nodes.filter((n) => n.type === 'console').map((n) => `${n.id}:${(n.data as any).name}:${s.statuses[n.id] ?? ''}:${s.live[n.id] ? 1 : 0}`).join(',') + '|' + w.groups.map((g) => g.name).join(','))
        .join('#') + p.activeWorkspaceId
    })
  )
  return useMemo(() => {
    if (query == null) return []
    const q = norm(query)
    const app = useApp.getState()
    const wsId = app.project?.activeWorkspaceId
    const consoles = allConsoles().sort((a, b) => (a.workspaceId === wsId ? 0 : 1) - (b.workspaceId === wsId ? 0 : 1))
    const out: MentionOption[] = []
    for (const c of consoles) {
      const name = c.data.name as string
      if (q && !norm(name).startsWith(q) && !norm(name).includes(q)) continue
      out.push({
        key: c.id,
        token: name.replace(/\s+/g, ''),
        label: name,
        meta: agentLabel(c.data.agentId),
        color: agentColor(c.data.agentId),
        status: app.statuses[c.id] ?? (app.live[c.id] ? 'idle' : 'exited')
      })
    }
    for (const g of activeWs()?.groups ?? []) {
      if (q && !norm(g.name).includes(q)) continue
      const n = activeWs()!.nodes.filter((x) => x.groupId === g.id).length
      out.push({ key: g.id, token: g.name.replace(/\s+/g, ''), label: g.name, meta: `team · ${n}`, color: ROLE_TINT[g.role], team: true })
    }
    if (!q || 'everyone'.startsWith(q) || 'all'.startsWith(q)) out.push({ key: '__all', token: 'all', label: 'everyone', meta: 'all consoles here', team: true, color: 'var(--muted)' })
    return out.slice(0, 9)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sig])
}

/** Text input that routes through runCommand; shared by the bar and the thread drawer. */
export function CommandInput({
  placeholder,
  autoFocus,
  popupAlign,
  primary
}: {
  placeholder?: string
  autoFocus?: boolean
  popupAlign?: 'left' | 'right'
  /** the bottom bar's input: takes text back from Helm's "Edit" */
  primary?: boolean
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [closed, setClosed] = useState(false)
  const histPos = useRef<number | null>(null)
  const draft = useRef('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  // Helm "Edit": the goal / message comes back here to be changed
  const draftN = useHelm((s) => (primary ? (s.draft?.n ?? 0) : 0))
  useEffect(() => {
    if (!primary || !draftN) return
    const t = useHelm.getState().draft?.text ?? ''
    setText(t)
    setClosed(true)
    histPos.current = null
    requestAnimationFrame(() => {
      const el = input.current
      if (!el) return
      el.focus()
      el.setSelectionRange(t.length, t.length)
      setCaret(t.length)
    })
  }, [draftN, primary])

  // @query right before the caret
  const query = useMemo(() => {
    if (closed) return null
    const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret))
    return m?.[2] ?? null
  }, [text, caret, closed])
  const options = useMentionOptions(query)
  const open = query != null && options.length > 0

  useEffect(() => setSel(0), [query])

  const accept = (o: MentionOption) => {
    const before = text.slice(0, caret).replace(/@([\w.-]*)$/, `@${o.token} `)
    const after = text.slice(caret).replace(/^\S*\s?/, '')
    const next = before + after
    setText(next)
    setClosed(false)
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(before.length, before.length)
      setCaret(before.length)
    })
  }

  const history = () =>
    useThread
      .getState()
      .entries.filter((e) => e.kind === 'user')
      .map((e) => e.text)
      .filter((t, i, a) => t !== a[i - 1])

  const submit = () => {
    const t = text.trim()
    if (!t) {
      // Enter in an empty bar runs Helm's first suggestion, else the Inbox's highlighted answer
      const i = primaryIndex()
      if (i != null) return runHelmOption(i)
      const f = primary ? frontItem() : null
      const p = f ? f.actions.findIndex((a) => a.primary) : -1
      if (f && p >= 0 && settled()) runAction(f, p)
      return
    }
    setText('')
    setCaret(0)
    histPos.current = null
    // a question or finished work in front: the words go to that agent
    const f = primary && !useHelm.getState().card ? frontItem() : null
    if (f?.replyTo && !t.startsWith('@')) {
      useThread.getState().add('user', `→ ${f.replyTo.label}: ${t}`, 'typed')
      void f.replyTo.send(t)
      // only a reply that leaves at once is reported as sent: a charter is edited in front of you,
      // and work for a team waits at the gate, where the card that comes up is the feedback
      if (f.kind === 'charter') useApp.getState().toast('The charter now says that', 'ok')
      else if (f.kind === 'ask') useApp.getState().toast(`Sent to ${f.replyTo.label}`, 'ok')
      return
    }
    runCommand(t, 'typed')
  }

  /** Tab / Shift+Tab, Ctrl+I and number keys drive the Inbox tray from the bar. */
  const inboxKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!primary || !useInbox.getState().items.length) return false
    if (e.key === 'Tab') {
      e.preventDefault()
      cycleFront(e.shiftKey ? -1 : 1)
      return true
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      toggleInbox()
      return true
    }
    if (!text && !e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key) && !useHelm.getState().card) {
      const f = frontItem()
      const i = Number(e.key) - 1
      if (f && i < f.actions.length) {
        e.preventDefault()
        if (settled()) runAction(f, i)
        return true
      }
    }
    return false
  }

  return (
    <>
      <input
        ref={input}
        className="command-input"
        placeholder={placeholder}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setClosed(false)
          histPos.current = null
        }}
        onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
        onBlur={() => window.setTimeout(() => setClosed(true), 120)}
        onFocus={() => setClosed(false)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              return setSel((s) => (s + 1) % options.length)
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              return setSel((s) => (s - 1 + options.length) % options.length)
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              const picked = options[Math.min(sel, options.length - 1)]
              return picked ? accept(picked) : undefined
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              return setClosed(true)
            }
          }
          if (inboxKey(e)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            if (text) {
              e.preventDefault()
              e.stopPropagation()
              setText('')
              histPos.current = null
            } else {
              if (useVoice.getState().pending) cancelPending()
              input.current?.blur()
            }
          } else if (e.key === 'ArrowUp') {
            const h = history()
            if (!h.length) return
            e.preventDefault()
            if (histPos.current == null) {
              draft.current = text
              histPos.current = h.length - 1
            } else histPos.current = Math.max(0, histPos.current - 1)
            setText(h[histPos.current] ?? '')
          } else if (e.key === 'ArrowDown' && histPos.current != null) {
            e.preventDefault()
            const h = history()
            if (histPos.current >= h.length - 1) {
              histPos.current = null
              setText(draft.current)
            } else {
              histPos.current += 1
              setText(h[histPos.current] ?? '')
            }
          }
        }}
      />
      {open && (
        <div className={`mention-pop ${popupAlign === 'right' ? 'up-right' : ''}`} onPointerDown={(e) => e.preventDefault()}>
          <div className="mention-head">Direct to</div>
          {options.map((o, i) => (
            <button key={o.key} className={`mention-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => accept(o)}>
              {o.team ? <span className="mi-team" style={{ background: o.color }} /> : <span className="dot" style={{ background: o.color }} />}
              <span className="mi-name">{o.label}</span>
              {o.status && (
                <span className={`st-${o.status}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span className="status-dot" />
                  <span className="mi-meta">{STATUS_TEXT[o.status]}</span>
                </span>
              )}
              <span className="mi-meta">{o.meta}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
