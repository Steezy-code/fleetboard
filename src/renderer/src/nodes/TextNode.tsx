import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TextAlignCenter, TextAlignEnd, TextAlignStart, Trash } from 'lucide-react'
import type { NodeProps } from './types'
import { activeWs, useApp } from '../state/store'
import { removeWithHooks, startNodeDrag } from '../board/NodeFrame'
import { FloatBar } from './content/util'

// Free text on the board. Drag to move, double-click to edit; the box grows with its content and an
// empty text removes itself when it loses focus.
// node.data = { text, color, font, size, align, opacity, autoFocus? }

export const TEXT_COLORS = ['#ede7e0', '#8f857b', '#ff4a2b', '#ff9a3c', '#f5c84c', '#4ccf8c', '#6b8cff', '#b583f5']
export const TEXT_FONTS = [
  { v: 'sans', label: 'Sans', css: 'var(--font)' },
  { v: 'serif', label: 'Serif', css: 'var(--serif)' },
  { v: 'mono', label: 'Mono', css: 'var(--mono)' },
  { v: 'hand', label: 'Hand', css: 'var(--serif)' }
] as const
export const TEXT_SIZES = [
  { v: 'S', px: 14 },
  { v: 'M', px: 20 },
  { v: 'L', px: 32 },
  { v: 'XL', px: 52 }
] as const

type Font = (typeof TEXT_FONTS)[number]['v']
type Size = (typeof TEXT_SIZES)[number]['v']
type Align = 'left' | 'center' | 'right'

export default function TextNode({ node, selected, zoom }: NodeProps) {
  const d = node.data
  const text: string = d.text ?? ''
  const color: string = d.color ?? TEXT_COLORS[0]
  const font: Font = d.font ?? 'sans'
  const size: Size = d.size ?? 'M'
  const align: Align = d.align ?? 'left'
  const opacity: number = d.opacity ?? 1
  const px = TEXT_SIZES.find((s) => s.v === size)?.px ?? 20
  const [editing, setEditing] = useState(!!d.autoFocus)
  const ref = useRef<HTMLTextAreaElement>(null)
  const born = useRef(d.autoFocus ? Date.now() : 0)

  const set = (patch: Record<string, any>) => useApp.getState().updateNodeData(node.id, patch)

  // created by the text tool: start typing right away
  useEffect(() => {
    if (d.autoFocus) set({ autoFocus: undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    // after the creating click has finished moving focus around
    const t = window.setTimeout(() => {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
    return () => window.clearTimeout(t)
  }, [editing])
  useEffect(() => {
    if (!selected && editing && document.activeElement !== ref.current) setEditing(false)
  }, [selected, editing])
  // an empty text that is no longer selected has no reason to exist
  useEffect(() => {
    if (selected || editing || text.trim()) return
    const t = window.setTimeout(() => {
      const n = activeWs()?.nodes.find((x) => x.id === node.id)
      if (n && !(n.data.text ?? '').trim() && !useApp.getState().selection.includes(node.id)) useApp.getState().removeNodes([node.id])
    }, 150)
    return () => window.clearTimeout(t)
  }, [selected, editing, text, node.id])

  // auto-grow the node to fit the text
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    const h = Math.max(px * 1.4, el.scrollHeight) + 4
    el.style.height = ''
    if (Math.abs(h - node.h) > 1) useApp.getState().updateNode(node.id, { h: Math.ceil(h) })
  }, [text, px, font, node.w, node.h, node.id])

  const finish = () => {
    // the click that created this text can steal focus right away: take it back
    if (born.current && Date.now() - born.current < 400) {
      window.setTimeout(() => ref.current?.focus(), 0)
      return
    }
    born.current = 0
    setEditing(false)
    // empty text removes itself (unless it is still being created)
    const n = activeWs()?.nodes.find((x) => x.id === node.id)
    if (n && !(n.data.text ?? '').trim()) {
      useApp.getState().removeNodes([node.id])
      useApp.getState().setSelection(useApp.getState().selection.filter((id) => id !== node.id))
    }
  }

  const fontCss = TEXT_FONTS.find((f) => f.v === font)!.css

  return (
    <div className="txt-wrap">
      {selected && (
        <FloatBar zoom={zoom} className="txt-bar">
          <div className="txt-colors">
            {TEXT_COLORS.map((c) => (
              <button key={c} className={`paper-dot sm ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} title={c} />
            ))}
            <label className="paper-dot sm custom" title="Custom color" style={!TEXT_COLORS.includes(color) ? { background: color } : undefined}>
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'} onChange={(e) => set({ color: e.target.value })} />
            </label>
          </div>
          <span className="float-sep" />
          <div className="txt-seg">
            {TEXT_FONTS.map((f) => (
              <button key={f.v} className={`${font === f.v ? 'on' : ''} f-${f.v}`} onClick={() => set({ font: f.v })} title={f.label}>
                Aa
              </button>
            ))}
          </div>
          <span className="float-sep" />
          <div className="txt-seg">
            {TEXT_SIZES.map((s) => (
              <button key={s.v} className={size === s.v ? 'on' : ''} onClick={() => set({ size: s.v })}>
                {s.v}
              </button>
            ))}
          </div>
          <span className="float-sep" />
          <div className="txt-seg">
            {(['left', 'center', 'right'] as Align[]).map((a) => {
              const Icon = a === 'left' ? TextAlignStart : a === 'center' ? TextAlignCenter : TextAlignEnd
              return (
                <button key={a} className={align === a ? 'on' : ''} onClick={() => set({ align: a })} title={`Align ${a}`}>
                  <Icon size={13} />
                </button>
              )
            })}
          </div>
          <span className="float-sep" />
          <input
            className="tb-range txt-opacity"
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            onChange={(e) => set({ opacity: Number(e.target.value) / 100 })}
            title={`Opacity ${Math.round(opacity * 100)}%`}
          />
          <span className="float-sep" />
          <button className="icon-btn sm" title="Delete text" onPointerDown={(e) => e.preventDefault()} onClick={() => removeWithHooks([node.id])}>
            <Trash size={13} />
          </button>
        </FloatBar>
      )}
      <div
        className={`txt ${editing ? 'editing' : ''} ${selected ? 'sel' : ''}`}
        onPointerDown={(e) => {
          if (editing && (e.target as HTMLElement).tagName === 'TEXTAREA') return
          startNodeDrag(e, node)
        }}
        onDoubleClick={() => setEditing(true)}
      >
        <textarea
          ref={ref}
          className={`txt-input f-${font}`}
          value={text}
          readOnly={!editing}
          tabIndex={editing ? 0 : -1}
          rows={1}
          placeholder="Type something"
          spellCheck={false}
          style={{ color, fontFamily: fontCss, fontSize: px, textAlign: align, opacity }}
          onChange={(e) => set({ text: e.target.value })}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
          }}
        />
      </div>
    </div>
  )
}
