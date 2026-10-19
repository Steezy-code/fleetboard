import { useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Users } from 'lucide-react'
import { mentionToken } from '../engine/orchestrator'
import { agentColor, agentLabel } from '../engine/consoles'
import { useFleet } from './fleet'

interface Suggestion {
  key: string
  token: string
  label: string
  sub: string
  color: string
  team?: boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

/** Single-line command input with @mention autocomplete of console and team names. */
export function MentionInput({
  placeholder,
  onSubmit,
  autoFocus,
  disabled
}: {
  placeholder: string
  onSubmit: (text: string) => void
  autoFocus?: boolean
  disabled?: boolean
}) {
  const fleet = useFleet()
  const [value, setValue] = useState('')
  const [query, setQuery] = useState<string | null>(null)
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLInputElement>(null)

  const all = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [{ key: 'all', token: '@all', label: 'all', sub: `every console · ${fleet.consoles.length}`, color: 'var(--accent)', team: true }]
    for (const t of fleet.teams)
      out.push({ key: t.id, token: mentionToken(t.name), label: t.name, sub: `team · ${t.memberIds.length}`, color: 'var(--accent)', team: true })
    for (const c of fleet.consoles)
      out.push({ key: c.id, token: mentionToken(c.name), label: c.name, sub: agentLabel(c.agentId), color: agentColor(c.agentId) })
    return out
  }, [fleet])

  const matches = useMemo(() => {
    if (query === null) return []
    const q = norm(query)
    return all.filter((s) => norm(s.label).startsWith(q) || (q.length > 1 && norm(s.label).includes(q))).slice(0, 8)
  }, [all, query])

  const sync = (text: string, caret: number) => {
    const m = /(^|\s)@([\w.\-]*)$/.exec(text.slice(0, caret))
    setQuery(m ? m[2] : null)
    setHi(0)
  }

  const pick = (s: Suggestion) => {
    const el = ref.current!
    const caret = el.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@([\w.\-]*)$/, `${s.token} `)
    const next = before + value.slice(caret).replace(/^\s+/, '')
    setValue(next)
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }

  const submit = () => {
    const t = value.trim()
    if (!t) return
    onSubmit(t)
    setValue('')
    setQuery(null)
  }

  return (
    <div className="orch-input-wrap">
      {matches.length > 0 && (
        <div className="menu orch-mentions">
          <div className="menu-label label">Direct to</div>
          {matches.map((s, i) => (
            <button
              key={s.key}
              className={`menu-item ${i === hi ? 'on' : ''}`}
              onMouseDown={(e) => (e.preventDefault(), pick(s))}
              onMouseEnter={() => setHi(i)}
            >
              {s.team ? <Users size={13} className="ic" /> : <span className="agent-dot" style={{ background: s.color }} />}
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.label}
              </span>
              <span className="dim small">{s.sub}</span>
            </button>
          ))}
        </div>
      )}
      <div className="orch-input">
        <span className="orch-orb" />
        <input
          ref={ref}
          className="orch-field"
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            sync(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onClick={(e) => sync(value, (e.target as HTMLInputElement).selectionStart ?? value.length)}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (matches.length) {
              if (e.key === 'ArrowDown') return e.preventDefault(), setHi((hi + 1) % matches.length)
              if (e.key === 'ArrowUp') return e.preventDefault(), setHi((hi - 1 + matches.length) % matches.length)
              if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(matches[hi])
              if (e.key === 'Escape') return e.preventDefault(), setQuery(null)
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="icon-btn sm" title="Send (Enter)" disabled={!value.trim()} onClick={submit}>
          <CornerDownLeft size={13} />
        </button>
      </div>
    </div>
  )
}
