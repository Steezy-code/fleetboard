import { useEffect, useRef, useState } from 'react'
import type { Camera, InkItem } from '@shared/types'
import { useApp } from '../../state/store'
import { textBox } from './geometry'
import { inkFontClass } from './InkShape'
import { useInkUi } from './inkState'

/** In-place text editor for a shape's text or a label, positioned over the item in screen space. */
export function InkTextEditor({ item, cam }: { item: InkItem; cam: Camera }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(item.text ?? '')
  const done = useRef(false)
  const z = cam.zoom
  const label = item.kind === 'label'
  const fs = (item.fontSize ?? (label ? 20 : 16)) * z

  const born = useRef(Date.now())
  useEffect(() => {
    // after the click that opened the editor has finished moving focus around
    const t = window.setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [])

  const commit = () => {
    if (done.current) return
    if (Date.now() - born.current < 350 && document.hasFocus()) {
      // focus was stolen by the creating click: take it back
      window.setTimeout(() => ref.current?.focus(), 0)
      return
    }
    done.current = true
    const app = useApp.getState()
    const value = text.replace(/\s+$/, '')
    if (label) {
      if (!value.trim()) app.removeInk([item.id])
      else {
        const el = ref.current
        const w = el ? Math.ceil(el.offsetWidth / z) + 2 : 0
        const h = el ? Math.ceil(el.offsetHeight / z) : 0
        app.updateInk(item.id, { text: value, w, h })
      }
    } else if (value !== (item.text ?? '')) app.updateInk(item.id, { text: value || undefined })
    useInkUi.setState({ editing: null })
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      commit()
    }
  }

  const common = {
    ref,
    value: text,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: onKey,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation()
  }

  if (label) {
    return (
      <div className="ink-editor" style={{ left: item.x * z + cam.x, top: item.y * z + cam.y }}>
        <textarea
          {...common}
          className={`ink-text ink-label-edit ${inkFontClass(item)}`}
          rows={1}
          placeholder="Text"
          style={{ fontSize: fs, color: item.stroke, minWidth: Math.max(item.w * z, fs) }}
        />
      </div>
    )
  }
  const tb = textBox(item)
  return (
    <div
      className="ink-editor centered"
      style={{ left: tb.x * z + cam.x, top: tb.y * z + cam.y, width: tb.w * z, height: tb.h * z }}
    >
      <textarea
        {...common}
        className={`ink-text ink-shape-edit ${inkFontClass(item)} ${item.kind === 'line' || item.kind === 'arrow' ? 'on-line' : ''}`}
        rows={1}
        style={{ fontSize: fs, color: item.stroke, maxWidth: tb.w * z }}
      />
    </div>
  )
}
