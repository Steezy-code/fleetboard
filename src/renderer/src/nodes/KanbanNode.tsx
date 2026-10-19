import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Ellipsis, Flag, Plus, Trash, X } from 'lucide-react'
import type { NodeProps } from './types'
import { uid } from '../lib/api'
import { activeWs, useApp } from '../state/store'
import { addDays, dueInfo, todayYmd, useDismiss, ymd } from './content/util'

// Kanban board: columns of cards with due dates and priorities. Cards and column headers drag with the
// pointer (live reordering, a ghost follows the cursor). All state lives in node.data.columns.

export type Priority = 'none' | 'low' | 'med' | 'high'
export interface KCard {
  id: string
  title: string
  desc?: string
  due?: string
  priority?: Priority
}
export interface KColumn {
  id: string
  title: string
  cards: KCard[]
}

const DEFAULT_COLUMNS: KColumn[] = [
  { id: 'backlog', title: 'Backlog', cards: [] },
  { id: 'todo', title: 'To do', cards: [] },
  { id: 'doing', title: 'In progress', cards: [] },
  { id: 'done', title: 'Done', cards: [] }
]

export const PRIORITIES: { v: Priority; label: string; color: string }[] = [
  { v: 'none', label: 'None', color: 'var(--line-2)' },
  { v: 'low', label: 'Low', color: '#6b8cff' },
  { v: 'med', label: 'Med', color: '#f5b740' },
  { v: 'high', label: 'High', color: '#ff4a2b' }
]
const prColor = (p?: Priority) => PRIORITIES.find((x) => x.v === (p ?? 'none'))!.color

type Drag =
  | { kind: 'card'; card: KCard; x: number; y: number; offX: number; offY: number; w: number; h: number }
  | { kind: 'col'; colId: string }

export default function KanbanNode({ node, zoom }: NodeProps) {
  const saved: KColumn[] = node.data.columns ?? DEFAULT_COLUMNS
  const [preview, setPreview] = useState<KColumn[] | null>(null)
  const columns = preview ?? saved
  const [adding, setAdding] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  const save = (cols: KColumn[]) => useApp.getState().updateNodeData(node.id, { columns: cols })
  const mapCol = (id: string, fn: (c: KColumn) => KColumn) => save(saved.map((c) => (c.id === id ? fn(c) : c)))

  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 2)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [columns.length])

  // vertical wheel scrolls the columns sideways when they overflow (and the list under the cursor can't scroll)
  const onWheel = (e: React.WheelEvent) => {
    const el = stripRef.current
    if (!el || !overflowing || e.ctrlKey || e.metaKey) return
    const list = (e.target as HTMLElement).closest('.kb-cards') as HTMLElement | null
    if (list && list.scrollHeight > list.clientHeight + 1 && !e.shiftKey) return
    el.scrollLeft += e.deltaY + e.deltaX
  }

  // ---------- card drag ----------
  const startCardDrag = (e: React.PointerEvent, card: KCard) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, textarea')) return
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    let current = saved
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
        started = true
        document.body.classList.add('kb-dragging')
      }
      setDrag({ kind: 'card', card, x: ev.clientX, y: ev.clientY, offX: sx - r.left, offY: sy - r.top, w: r.width / zoom, h: r.height / zoom })
      const target = locate(ev.clientX, ev.clientY, card.id)
      if (!target) return
      const without = current.map((c) => ({ ...c, cards: c.cards.filter((k) => k.id !== card.id) }))
      const next = without.map((c) => (c.id === target.col ? { ...c, cards: [...c.cards.slice(0, target.index), card, ...c.cards.slice(target.index)] } : c))
      current = next
      setPreview(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('kb-dragging')
      if (started) save(current)
      else setEditing(card.id)
      setPreview(null)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Column + insertion index under a screen point (ignores the dragged card). */
  const locate = (x: number, y: number, cardId: string) => {
    const root = rootRef.current
    if (!root) return null
    const cols = [...root.querySelectorAll<HTMLElement>('[data-kcol]')]
    if (!cols.length) return null
    let best = cols[0]
    let bestD = Infinity
    for (const c of cols) {
      const r = c.getBoundingClientRect()
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    const cards = [...best.querySelectorAll<HTMLElement>('[data-kcard]')].filter((c) => c.dataset.kcard !== cardId)
    let index = cards.length
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) {
        index = i
        break
      }
    }
    return { col: best.dataset.kcol!, index }
  }

  // ---------- column drag ----------
  const startColDrag = (e: React.PointerEvent, colId: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return
    const sx = e.clientX
    let started = false
    let current = saved
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - sx) < 5) return
        started = true
        setDrag({ kind: 'col', colId })
        document.body.classList.add('kb-dragging')
      }
      const els = [...rootRef.current!.querySelectorAll<HTMLElement>('[data-kcol]')]
      const others = els.filter((c) => c.dataset.kcol !== colId)
      let index = others.length
      for (let i = 0; i < others.length; i++) {
        const r = others[i].getBoundingClientRect()
        if (ev.clientX < r.left + r.width / 2) {
          index = i
          break
        }
      }
      const col = current.find((c) => c.id === colId)!
      const rest = current.filter((c) => c.id !== colId)
      const next = [...rest.slice(0, index), col, ...rest.slice(index)]
      if (next.some((c, i) => c.id !== current[i].id)) {
        current = next
        setPreview(next)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('kb-dragging')
      if (started) save(current)
      setPreview(null)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- column actions ----------
  const moveCol = (id: string, to: 'left' | 'right' | 'start' | 'end') => {
    const i = saved.findIndex((c) => c.id === id)
    const col = saved[i]
    const rest = saved.filter((c) => c.id !== id)
    const j = to === 'start' ? 0 : to === 'end' ? rest.length : to === 'left' ? Math.max(0, i - 1) : Math.min(rest.length, i + 1)
    save([...rest.slice(0, j), col, ...rest.slice(j)])
    setMenu(null)
  }
  const deleteCol = async (col: KColumn) => {
    setMenu(null)
    if (col.cards.length) {
      const ok = await useApp.getState().confirm({
        title: `Delete “${col.title}”?`,
        body: `Its ${col.cards.length} card${col.cards.length === 1 ? '' : 's'} will be deleted too.`,
        confirm: 'Delete column',
        danger: true
      })
      if (!ok) return
    }
    const fresh: KColumn[] = activeWs()?.nodes.find((n) => n.id === node.id)?.data.columns ?? DEFAULT_COLUMNS
    save(fresh.filter((c) => c.id !== col.id))
  }
  const addColumn = () => {
    const id = uid('col')
    save([...saved, { id, title: 'New column', cards: [] }])
    setRenaming(id)
    requestAnimationFrame(() => {
      const el = stripRef.current
      if (el) el.scrollLeft = el.scrollWidth
    })
  }

  return (
    <div className="kb" ref={rootRef}>
      <div ref={stripRef} className={`kb-strip ${overflowing ? 'no-board-wheel' : ''}`} onWheel={onWheel}>
        {columns.map((col, ci) => (
          <div
            key={col.id}
            className={`kb-col ${drag?.kind === 'col' && drag.colId === col.id ? 'lifted' : ''} ${drag?.kind === 'card' ? 'drop-ok' : ''}`}
            data-kcol={col.id}
          >
            <div className="kb-col-head" onPointerDown={(e) => startColDrag(e, col.id)}>
              {renaming === col.id ? (
                <RenameInput
                  value={col.title}
                  onDone={(v) => {
                    setRenaming(null)
                    if (v && v !== col.title) mapCol(col.id, (c) => ({ ...c, title: v }))
                  }}
                />
              ) : (
                <span className="kb-col-title" onDoubleClick={() => setRenaming(col.id)} title="Drag to reorder · double-click to rename">
                  {col.title}
                </span>
              )}
              <span className="kb-count">{col.cards.length}</span>
              <span className="spacer" />
              <div className="kb-menu-wrap">
                <button className={`icon-btn sm ${menu === col.id ? 'on' : ''}`} title="Column options" onClick={() => setMenu(menu === col.id ? null : col.id)}>
                  <Ellipsis size={14} />
                </button>
                {menu === col.id && (
                  <ColumnMenu
                    first={ci === 0}
                    last={ci === columns.length - 1}
                    onClose={() => setMenu(null)}
                    onRename={() => {
                      setMenu(null)
                      setRenaming(col.id)
                    }}
                    onMove={(to) => moveCol(col.id, to)}
                    onDelete={() => deleteCol(col)}
                  />
                )}
              </div>
            </div>

            <div className="kb-cards scrollable">
              {col.cards.map((card) =>
                editing === card.id ? (
                  <CardForm
                    key={card.id}
                    initial={card}
                    onCancel={() => setEditing(null)}
                    onSave={(c) => {
                      setEditing(null)
                      mapCol(col.id, (k) => ({ ...k, cards: k.cards.map((x) => (x.id === card.id ? { ...x, ...c } : x)) }))
                    }}
                    onDelete={() => {
                      setEditing(null)
                      mapCol(col.id, (k) => ({ ...k, cards: k.cards.filter((x) => x.id !== card.id) }))
                    }}
                  />
                ) : (
                  <CardView
                    key={card.id}
                    card={card}
                    placeholder={drag?.kind === 'card' && drag.card.id === card.id}
                    done={col.id === 'done'}
                    onPointerDown={(e) => startCardDrag(e, card)}
                  />
                )
              )}
              {adding === col.id ? (
                <CardForm
                  initial={{ id: '', title: '', priority: 'none' }}
                  isNew
                  onCancel={() => setAdding(null)}
                  onSave={(c) => {
                    mapCol(col.id, (k) => ({ ...k, cards: [...k.cards, { ...c, id: uid('card') }] }))
                  }}
                />
              ) : (
                <button className="kb-add" onClick={() => setAdding(col.id)}>
                  <Plus size={13} /> Add card
                </button>
              )}
            </div>
          </div>
        ))}
        <button className="kb-add-col" onClick={addColumn} title="Add column">
          <Plus size={14} />
          <span>Column</span>
        </button>
      </div>
      {drag?.kind === 'card' &&
        createPortal(
          <div
            className="kb-ghost"
            style={{
              left: drag.x - drag.offX,
              top: drag.y - drag.offY,
              width: drag.w,
              transform: `scale(${zoom}) rotate(1.5deg)`
            }}
          >
            <CardView card={drag.card} />
          </div>,
          document.body
        )}
    </div>
  )
}

function CardView({
  card,
  placeholder,
  done,
  onPointerDown
}: {
  card: KCard
  placeholder?: boolean
  done?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}) {
  const due = card.due ? dueInfo(card.due) : null
  const pr = card.priority ?? 'none'
  return (
    <div
      className={`kb-card ${placeholder ? 'placeholder' : ''} ${done ? 'is-done' : ''}`}
      data-kcard={card.id}
      style={{ ['--pr' as any]: prColor(pr) }}
      onPointerDown={onPointerDown}
    >
      <div className="kb-card-title">{card.title}</div>
      {card.desc && <div className="kb-card-desc">{card.desc}</div>}
      {(due || pr !== 'none') && (
        <div className="kb-card-meta">
          {due && (
            <span className={`kb-due ${done ? '' : due.tone}`}>
              <CalendarDays size={11} /> {due.label}
            </span>
          )}
          {pr !== 'none' && (
            <span className="kb-pr" style={{ color: prColor(pr) }}>
              <Flag size={11} /> {PRIORITIES.find((p) => p.v === pr)!.label}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function CardForm({
  initial,
  isNew,
  onSave,
  onCancel,
  onDelete
}: {
  initial: KCard
  isNew?: boolean
  onSave: (c: Omit<KCard, 'id'>) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [desc, setDesc] = useState(initial.desc ?? '')
  const [showDesc, setShowDesc] = useState(!!initial.desc)
  const [due, setDue] = useState(initial.due ?? '')
  const [priority, setPriority] = useState<Priority>(initial.priority ?? 'none')
  const titleRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => titleRef.current?.focus(), [])

  const submit = () => {
    const t = title.trim()
    if (!t) return isNew ? onCancel() : undefined
    onSave({ title: t, desc: desc.trim() || undefined, due: due || undefined, priority })
    if (isNew) {
      setTitle('')
      setDesc('')
      setShowDesc(false)
      setDue('')
      setPriority('none')
      titleRef.current?.focus()
    }
  }
  const today = todayYmd()
  const tomorrow = ymd(addDays(new Date(), 1))

  return (
    <div
      ref={ref}
      className="kb-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <input
        ref={titleRef}
        className="kb-form-title"
        placeholder="Card title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}
      />
      {showDesc ? (
        <textarea className="kb-form-desc" placeholder="Description" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
      ) : (
        <button className="kb-link" onClick={() => setShowDesc(true)}>
          + Description
        </button>
      )}
      <div className="kb-form-row">
        <span className="kb-form-label">Due</span>
        <button className={`kb-mini ${due === today ? 'on' : ''}`} onClick={() => setDue(due === today ? '' : today)}>
          Today
        </button>
        <button className={`kb-mini ${due === tomorrow ? 'on' : ''}`} onClick={() => setDue(due === tomorrow ? '' : tomorrow)}>
          Tomorrow
        </button>
        <input className="kb-date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        {due && (
          <button className="icon-btn sm" title="Clear due date" onClick={() => setDue('')}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="kb-form-row">
        <span className="kb-form-label">Priority</span>
        <div className="kb-prs">
          {PRIORITIES.map((p) => (
            <button key={p.v} className={`kb-mini ${priority === p.v ? 'on' : ''}`} onClick={() => setPriority(p.v)}>
              <span className="kb-pr-dot" style={{ background: p.color }} />
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="kb-form-actions">
        {onDelete && (
          <button className="icon-btn sm danger" title="Delete card" onClick={onDelete}>
            <Trash size={13} />
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onCancel}>
          {isNew ? 'Done' : 'Cancel'}
        </button>
        <button className="btn primary sm" onClick={submit} disabled={!title.trim()}>
          {isNew ? 'Add card' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function ColumnMenu({
  first,
  last,
  onClose,
  onRename,
  onMove,
  onDelete
}: {
  first: boolean
  last: boolean
  onClose: () => void
  onRename: () => void
  onMove: (to: 'left' | 'right' | 'start' | 'end') => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, true, onClose)
  return (
    <div ref={ref} className="menu kb-menu" onPointerDown={(e) => e.stopPropagation()}>
      <button className="menu-item" onClick={onRename}>
        Rename
      </button>
      <div className="menu-sep" />
      <button className="menu-item" disabled={first} onClick={() => onMove('left')}>
        Move left
      </button>
      <button className="menu-item" disabled={last} onClick={() => onMove('right')}>
        Move right
      </button>
      <button className="menu-item" disabled={first} onClick={() => onMove('start')}>
        Move to start
      </button>
      <button className="menu-item" disabled={last} onClick={() => onMove('end')}>
        Move to end
      </button>
      <div className="menu-sep" />
      <button className="menu-item danger" onClick={onDelete}>
        Delete column
      </button>
    </div>
  )
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (val: string) => {
    if (done.current) return
    done.current = true
    onDone(val.trim())
  }
  return (
    <input
      ref={ref}
      className="kb-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v)
        if (e.key === 'Escape') finish(value)
      }}
    />
  )
}
