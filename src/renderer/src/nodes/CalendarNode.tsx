import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash, X } from 'lucide-react'
import type { NodeProps } from './types'
import { uid } from '../lib/api'
import { useApp } from '../state/store'
import { Switch } from '../ui/Modal'
import { MONTHS, addDays, fmtTime, parseYmd, shortDate, todayYmd, useDismiss, ymd } from './content/util'

// Month calendar (Monday first). Events live in node.data.events.

export interface CalEvent {
  id: string
  title: string
  date: string
  allDay: boolean
  time?: string
  color: string
}

export const EVENT_COLORS = ['#ff4a2b', '#ff9a3c', '#f5c84c', '#3ecf8e', '#3fc8d8', '#6b8cff', '#b583f5', '#a8a29e']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type Pop = { type: 'form'; ev: CalEvent; isNew: boolean } | { type: 'day'; date: string }

const sortEvents = (a: CalEvent, b: CalEvent) => (a.allDay === b.allDay ? (a.time ?? '').localeCompare(b.time ?? '') : a.allDay ? -1 : 1)

export default function CalendarNode({ node }: NodeProps) {
  const events: CalEvent[] = node.data.events ?? []
  const now = new Date()
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => node.data.view ?? { y: now.getFullYear(), m: now.getMonth() })
  const [picked, setPicked] = useState<string | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  const today = todayYmd()

  const save = (evs: CalEvent[]) => useApp.getState().updateNodeData(node.id, { events: evs })
  const go = (d: number) => {
    const dt = new Date(cursor.y, cursor.m + d, 1)
    setCursor({ y: dt.getFullYear(), m: dt.getMonth() })
  }
  const goToday = () => {
    setCursor({ y: now.getFullYear(), m: now.getMonth() })
    setPicked(today)
  }

  const first = new Date(cursor.y, cursor.m, 1)
  const offset = (first.getDay() + 6) % 7
  const daysIn = new Date(cursor.y, cursor.m + 1, 0).getDate()
  const weeks = Math.ceil((offset + daysIn) / 7)
  const start = addDays(first, -offset)
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i))

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e])
    for (const list of m.values()) list.sort(sortEvents)
    return m
  }, [events])

  // how many chips fit in a cell at the current node height
  const gridH = node.h - 32 - 52 - 26
  const cellH = gridH / weeks
  const cap = Math.max(0, Math.floor((cellH - 26) / 19))

  const newEvent = (date: string) =>
    setPop({ type: 'form', isNew: true, ev: { id: uid('ev'), title: '', date, allDay: true, color: EVENT_COLORS[0] } })

  return (
    <div className="cal">
      <div className="cal-head">
        <div className="cal-title">
          <em>{MONTHS[cursor.m]}</em> <span>{cursor.y}</span>
        </div>
        <span className="spacer" />
        <div className="cal-nav">
          <button className="icon-btn sm" title="Previous month" onClick={() => go(-1)}>
            <ChevronLeft size={15} />
          </button>
          <button className="btn sm ghost" onClick={goToday}>
            Today
          </button>
          <button className="icon-btn sm" title="Next month" onClick={() => go(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
        <button className="btn primary sm" onClick={() => newEvent(picked ?? (cursor.y === now.getFullYear() && cursor.m === now.getMonth() ? today : ymd(first)))}>
          <Plus size={13} /> New
        </button>
      </div>
      <div className="cal-week">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={i > 4 ? 'wknd' : ''}>
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid" style={{ gridTemplateRows: `repeat(${weeks}, 1fr)` }}>
        {days.map((d, i) => {
          const key = ymd(d)
          const list = byDay.get(key) ?? []
          const out = d.getMonth() !== cursor.m
          const shown = list.length > cap ? list.slice(0, Math.max(0, cap - 1)) : list
          const more = list.length - shown.length
          return (
            <div
              key={key}
              className={`cal-cell ${out ? 'out' : ''} ${key === today ? 'today' : ''} ${picked === key ? 'picked' : ''} ${i % 7 > 4 ? 'wknd' : ''}`}
              onClick={() => setPicked(key)}
              onDoubleClick={() => newEvent(key)}
            >
              <span className="cal-num">{d.getDate()}</span>
              <div className="cal-evs">
                {shown.map((e) => (
                  <button
                    key={e.id}
                    className="cal-ev"
                    style={{ ['--ev' as any]: e.color }}
                    title={`${e.title}${e.allDay ? '' : ' · ' + fmtTime(e.time)}`}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setPop({ type: 'form', isNew: false, ev: e })
                    }}
                    onDoubleClick={(ev) => ev.stopPropagation()}
                  >
                    {!e.allDay && e.time && <span className="cal-ev-time">{fmtTime(e.time)}</span>}
                    <span className="cal-ev-title">{e.title || 'Untitled'}</span>
                  </button>
                ))}
                {more > 0 && (
                  <button
                    className="cal-more"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setPop({ type: 'day', date: key })
                    }}
                  >
                    +{more} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {pop?.type === 'form' && (
        <EventForm
          key={pop.ev.id}
          initial={pop.ev}
          isNew={pop.isNew}
          onClose={() => setPop(null)}
          onSave={(ev) => {
            const exists = events.some((x) => x.id === ev.id)
            save(exists ? events.map((x) => (x.id === ev.id ? ev : x)) : [...events, ev])
            const d = parseYmd(ev.date)
            setCursor({ y: d.getFullYear(), m: d.getMonth() })
            setPop(null)
          }}
          onDelete={() => {
            save(events.filter((x) => x.id !== pop.ev.id))
            setPop(null)
          }}
        />
      )}
      {pop?.type === 'day' && (
        <DayList
          date={pop.date}
          events={byDay.get(pop.date) ?? []}
          onClose={() => setPop(null)}
          onPick={(e) => setPop({ type: 'form', isNew: false, ev: e })}
          onNew={() => newEvent(pop.date)}
        />
      )}
    </div>
  )
}

function EventForm({
  initial,
  isNew,
  onSave,
  onClose,
  onDelete
}: {
  initial: CalEvent
  isNew: boolean
  onSave: (e: CalEvent) => void
  onClose: () => void
  onDelete: () => void
}) {
  const [ev, setEv] = useState(initial)
  const ref = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  useDismiss(ref, true, onClose)
  useEffect(() => titleRef.current?.focus(), [])
  const set = (p: Partial<CalEvent>) => setEv((e) => ({ ...e, ...p }))
  const submit = () => {
    if (!ev.title.trim()) return titleRef.current?.focus()
    onSave({ ...ev, title: ev.title.trim(), time: ev.allDay ? undefined : ev.time || '09:00' })
  }
  return (
    <div className="cal-pop-wrap">
      <div ref={ref} className="cal-pop" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()}>
        <div className="cal-pop-head">
          <span className="label">{isNew ? 'New event' : 'Edit event'}</span>
          <span className="spacer" />
          <button className="icon-btn sm" onClick={onClose} title="Close">
            <X size={13} />
          </button>
        </div>
        <input ref={titleRef} className="input" placeholder="Event title" value={ev.title} onChange={(e) => set({ title: e.target.value })} />
        <div className="cal-form-row">
          <span className="cal-form-label">Date</span>
          <input className="input sm" type="date" value={ev.date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
        </div>
        <div className="cal-form-row">
          <span className="cal-form-label">All day</span>
          <Switch on={ev.allDay} onChange={(v) => set({ allDay: v, time: v ? undefined : ev.time ?? '09:00' })} />
          {!ev.allDay && <input className="input sm" type="time" value={ev.time ?? '09:00'} onChange={(e) => set({ time: e.target.value })} />}
        </div>
        <div className="cal-form-row">
          <span className="cal-form-label">Color</span>
          <div className="cal-colors">
            {EVENT_COLORS.map((c) => (
              <button key={c} className={`cal-color ${ev.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} />
            ))}
          </div>
        </div>
        <div className="cal-pop-foot">
          {!isNew && (
            <button className="btn sm ghost danger-text" onClick={onDelete}>
              <Trash size={12} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn sm primary" onClick={submit}>
            {isNew ? 'Add event' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DayList({ date, events, onClose, onPick, onNew }: { date: string; events: CalEvent[]; onClose: () => void; onPick: (e: CalEvent) => void; onNew: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, true, onClose)
  return (
    <div className="cal-pop-wrap">
      <div ref={ref} className="cal-pop">
        <div className="cal-pop-head">
          <span className="label">{shortDate(date)}</span>
          <span className="spacer" />
          <button className="icon-btn sm" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <div className="cal-day-list scrollable">
          {events.map((e) => (
            <button key={e.id} className="cal-ev big" style={{ ['--ev' as any]: e.color }} onClick={() => onPick(e)}>
              {!e.allDay && e.time && <span className="cal-ev-time">{fmtTime(e.time)}</span>}
              <span className="cal-ev-title">{e.title}</span>
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={onNew}>
          <Plus size={12} /> Add event
        </button>
      </div>
    </div>
  )
}
