import { useRef, useState } from 'react'
import { Check, GripVertical, Plus, X } from 'lucide-react'
import type { NodeProps } from './types'
import { uid } from '../lib/api'
import { useApp } from '../state/store'

// "Objectives": a titled checklist with progress. node.data = { title, items: [{ id, text, done }] }

export interface CheckItem {
  id: string
  text: string
  done: boolean
}

export default function ChecklistNode({ node }: NodeProps) {
  const items: CheckItem[] = node.data.items ?? []
  const title: string = node.data.title ?? 'Objectives'
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<CheckItem[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const shown = preview ?? items
  const done = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  const set = (patch: Record<string, any>) => useApp.getState().updateNodeData(node.id, patch)
  const setItems = (next: CheckItem[]) => set({ items: next })
  const patchItem = (id: string, p: Partial<CheckItem>) => setItems(items.map((i) => (i.id === id ? { ...i, ...p } : i)))

  const add = () => {
    const t = draft.trim()
    if (!t) return
    setItems([...items, { id: uid('chk'), text: t, done: false }])
    setDraft('')
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }))
  }

  const startDrag = (e: React.PointerEvent, item: CheckItem) => {
    if (e.button !== 0) return
    e.preventDefault()
    let current = items
    setDragId(item.id)
    const move = (ev: PointerEvent) => {
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-chk]') ?? [])].filter((r) => r.dataset.chk !== item.id)
      let index = rows.length
      for (const [i, row] of rows.entries()) {
        const r = row.getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      const rest = current.filter((i) => i.id !== item.id)
      const next = [...rest.slice(0, index), item, ...rest.slice(index)]
      if (next.some((x, i) => x.id !== current[i]?.id)) {
        current = next
        setPreview(next)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setItems(current)
      setPreview(null)
      setDragId(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="chk">
      <div className="chk-head">
        <input className="chk-title" value={title} placeholder="Objectives" onChange={(e) => set({ title: e.target.value })} spellCheck={false} />
        <span className="chk-count">
          {done}/{items.length}
        </span>
      </div>
      <div className="chk-progress">
        <div className="chk-bar">
          <div className={`chk-fill ${pct === 100 ? 'full' : ''}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="chk-pct">{pct}%</span>
        {done > 0 && (
          <button className="chk-clear" onClick={() => setItems(items.filter((i) => !i.done))} title="Remove completed items">
            Clear done
          </button>
        )}
      </div>
      <div className="chk-list scrollable" ref={listRef}>
        {shown.map((item) => (
          <div key={item.id} className={`chk-item ${item.done ? 'done' : ''} ${dragId === item.id ? 'dragging' : ''}`} data-chk={item.id}>
            <span className="chk-grip" onPointerDown={(e) => startDrag(e, item)} title="Drag to reorder">
              <GripVertical size={12} />
            </span>
            <button className={`chk-box ${item.done ? 'on' : ''}`} onClick={() => patchItem(item.id, { done: !item.done })} title={item.done ? 'Mark not done' : 'Mark done'}>
              {item.done && <Check size={11} strokeWidth={3} />}
            </button>
            <ItemText item={item} onChange={(text) => patchItem(item.id, { text })} onDelete={() => setItems(items.filter((i) => i.id !== item.id))} />
            <button className="chk-del icon-btn sm" title="Delete" onClick={() => setItems(items.filter((i) => i.id !== item.id))}>
              <X size={12} />
            </button>
          </div>
        ))}
        {!items.length && <div className="chk-empty">No objectives yet. Add the first one below.</div>}
      </div>
      <div className="chk-add">
        <Plus size={13} className="chk-add-ic" />
        <input
          className="chk-add-input"
          placeholder="Add an objective…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
      </div>
    </div>
  )
}

function ItemText({ item, onChange, onDelete }: { item: CheckItem; onChange: (t: string) => void; onDelete: () => void }) {
  const [v, setV] = useState(item.text)
  const [focused, setFocused] = useState(false)
  const value = focused ? v : item.text
  return (
    <input
      className="chk-text"
      value={value}
      spellCheck={false}
      onFocus={() => {
        setV(item.text)
        setFocused(true)
      }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setFocused(false)
        const t = v.trim()
        if (!t) onDelete()
        else if (t !== item.text) onChange(t)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
