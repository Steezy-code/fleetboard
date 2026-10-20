import { useEffect, useRef, useState } from 'react'
import { Trash } from 'lucide-react'
import type { NodeProps } from './types'
import { useApp } from '../state/store'
import { removeWithHooks, startNodeDrag } from '../board/NodeFrame'
import { FloatBar } from './content/util'

// Sticky note: a square of colored paper. Drag it anywhere; double-click to write.
// node.data = { text, color }

export const PAPERS: readonly [{ name: string; color: string }, ...{ name: string; color: string }[]] = [
  { name: 'Yellow', color: '#d4a72c' },
  { name: 'Orange', color: '#e0893f' },
  { name: 'Red', color: '#d9654f' },
  { name: 'Green', color: '#7fae5c' },
  { name: 'Blue', color: '#5f97c9' },
  { name: 'Purple', color: '#9b7fd1' },
  { name: 'Grey', color: '#a39b91' }
]

export default function NoteNode({ node, selected, zoom }: NodeProps) {
  const color: string = node.data.color ?? PAPERS[0].color
  const text: string = node.data.text ?? ''
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // a fresh, empty note opens for writing
  useEffect(() => {
    if (!text && selected) setEditing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])
  useEffect(() => {
    if (!selected) setEditing(false)
  }, [selected])

  const set = (patch: Record<string, any>) => useApp.getState().updateNodeData(node.id, patch)

  return (
    <>
      {selected && !editing && (
        <FloatBar zoom={zoom}>
          {PAPERS.map((p) => (
            <button
              key={p.color}
              className={`paper-dot ${color.toLowerCase() === p.color ? 'on' : ''}`}
              style={{ background: p.color }}
              title={p.name}
              onClick={() => set({ color: p.color })}
            />
          ))}
          <span className="float-sep" />
          <button className="icon-btn sm" title="Delete note" onClick={() => removeWithHooks([node.id])}>
            <Trash size={13} />
          </button>
        </FloatBar>
      )}
      <div className="note-shadow">
        <div
          className={`note ${editing ? 'editing' : ''}`}
          style={{ ['--paper' as any]: color }}
          onPointerDown={(e) => {
            if (editing && (e.target as HTMLElement).tagName === 'TEXTAREA') return
            startNodeDrag(e, node)
          }}
          onDoubleClick={() => setEditing(true)}
        >
          <div className="note-strip" />
          <textarea
            ref={ref}
            className="note-text"
            value={text}
            readOnly={!editing}
            tabIndex={editing ? 0 : -1}
            placeholder={editing ? 'Write something…' : 'Double-click to write'}
            spellCheck={false}
            onChange={(e) => set({ text: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
            }}
          />
          <div className="note-fold" />
        </div>
      </div>
    </>
  )
}
