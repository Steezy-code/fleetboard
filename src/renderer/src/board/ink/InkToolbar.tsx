import { useMemo } from 'react'
import { Ban, Circle, Copy, Diamond, Minus, MoveRight, Pipette, Square, Trash, Type } from 'lucide-react'
import type { InkItem } from '@shared/types'
import { useApp, useWs } from '../../state/store'
import { duplicateInk, patchInk } from './inkState'
import { isClosedShape } from './geometry'

// Floating ink style panel next to the left rail: shows while drawing (pen / shapes) or when ink is selected.

export const STROKES = ['#f1ece4', '#ff4a2b', '#ff9a3c', '#f5c84c', '#4ccf8c', '#3fc8d8', '#6b8cff', '#b583f5']
export const FILLS = ['#ff6b5a', '#ffa94d', '#ffd43b', '#69db7c', '#4dd4e0', '#74a7ff', '#b197fc', '#a8a29e']
const WIDTHS = [
  { v: 2, label: 'Thin' },
  { v: 3.5, label: 'Medium' },
  { v: 6, label: 'Bold' }
]
const FONT_SIZES = [
  { v: 14, label: 'S' },
  { v: 20, label: 'M' },
  { v: 28, label: 'L' },
  { v: 40, label: 'XL' }
]
type Kind = InkItem['kind']
const SHAPES: { kind: Kind; icon: any; title: string }[] = [
  { kind: 'rect', icon: Square, title: 'Rectangle' },
  { kind: 'diamond', icon: Diamond, title: 'Diamond' },
  { kind: 'ellipse', icon: Circle, title: 'Ellipse' },
  { kind: 'arrow', icon: MoveRight, title: 'Arrow' },
  { kind: 'line', icon: Minus, title: 'Line' },
  { kind: 'label', icon: Type, title: 'Text label' }
]

type StylePatch = Partial<{ stroke: string; fill: string | undefined; width: number; opacity: number; dashed: boolean; sloppy: boolean; rounded: boolean; fontSize: number }>

const near = (a: number, b: number) => Math.abs(a - b) < 0.8

export function InkToolbar() {
  const tool = useApp((s) => s.tool)
  const shapeKind = useApp((s) => s.shapeKind)
  const style = useApp((s) => s.inkStyle)
  const selection = useApp((s) => s.selection)
  const ink = useWs((w) => w.ink)
  // while drawing, the panel edits the pen/shape style rather than the selection
  const sel = useMemo(() => {
    if (tool !== 'select') return []
    const s = new Set(selection)
    return (ink ?? []).filter((i) => s.has(i.id))
  }, [ink, selection, tool])

  const drawing = tool === 'pen' || tool === 'shape'
  if (!drawing && !(tool === 'select' && sel.length)) return null

  const first = sel[0]
  const cur = first
    ? { stroke: first.stroke, fill: first.fill, width: first.width, opacity: first.opacity ?? 1, dashed: !!first.dashed, sloppy: !!first.sloppy, rounded: !!first.rounded }
    : style
  const kinds = new Set<Kind>(first ? sel.map((i) => i.kind) : [tool === 'pen' ? 'path' : shapeKind])
  const any = (f: (k: Kind) => boolean) => [...kinds].some(f)
  const showFill = any(isClosedShape)
  const showShapeOpts = any((k) => k !== 'path' && k !== 'label')
  const showEdges = any((k) => k === 'rect' || k === 'diamond' || k === 'line' || k === 'arrow')
  const showFont = sel.some((i) => i.kind === 'label' || !!i.text)
  const fontSize = first?.fontSize ?? (first?.kind === 'label' ? 20 : 16)

  const apply = (p: StylePatch) => {
    const { fontSize: fsz, ...st } = p
    if (Object.keys(st).length) useApp.setState({ inkStyle: { ...useApp.getState().inkStyle, ...st } })
    if (!sel.length) return
    const patches: Record<string, Partial<InkItem>> = {}
    for (const i of sel) {
      const q: Partial<InkItem> = { ...st }
      if ('fill' in st && !isClosedShape(i.kind)) delete q.fill
      if (fsz && (i.kind === 'label' || i.text)) {
        q.fontSize = fsz
        // labels re-measure themselves at the new size
        if (i.kind === 'label') {
          q.w = 0
          q.h = 0
        }
      }
      patches[i.id] = q
    }
    patchInk(patches)
  }

  return (
    <div className="ink-toolbar" onPointerDown={(e) => e.stopPropagation()}>
      {tool === 'shape' && (
        <Section title="Shape">
          <div className="tb-grid six">
            {SHAPES.map((s) => (
              <button
                key={s.kind}
                className={`tb-opt ${shapeKind === s.kind ? 'on' : ''}`}
                title={s.title}
                onClick={() => useApp.setState({ shapeKind: s.kind })}
              >
                <s.icon size={15} />
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Stroke">
        <Swatches colors={STROKES} value={cur.stroke} onPick={(c) => apply({ stroke: c })} />
      </Section>

      {showFill && (
        <Section title="Background">
          <Swatches colors={FILLS} value={cur.fill} allowNone onPick={(c) => apply({ fill: c })} />
        </Section>
      )}

      <Section title={showShapeOpts ? 'Width · Style' : 'Width'}>
        <div className="tb-row">
          <div className="tb-group">
            {WIDTHS.map((w) => (
              <button key={w.v} className={`tb-opt ${near(cur.width, w.v) ? 'on' : ''}`} title={w.label} onClick={() => apply({ width: w.v })}>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" strokeWidth={w.v * 0.7} strokeLinecap="round" />
                </svg>
              </button>
            ))}
          </div>
          {showShapeOpts && (
            <div className="tb-group">
              <button className={`tb-opt ${!cur.dashed ? 'on' : ''}`} title="Solid" onClick={() => apply({ dashed: false })}>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <line x1="2" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <button className={`tb-opt ${cur.dashed ? 'on' : ''}`} title="Dashed" onClick={() => apply({ dashed: true })}>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <line x1="2" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="2" strokeDasharray="3.5 3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </Section>

      {showShapeOpts && (
        <Section title={showEdges ? 'Sloppiness · Edges' : 'Sloppiness'}>
          <div className="tb-row">
            <div className="tb-group">
              <button className={`tb-opt ${!cur.sloppy ? 'on' : ''}`} title="Architect" onClick={() => apply({ sloppy: false })}>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path d="M2 13 C6 13, 8 5, 16 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button className={`tb-opt ${cur.sloppy ? 'on' : ''}`} title="Artist" onClick={() => apply({ sloppy: true })}>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path d="M2 13 C5 12.4, 7 5.6, 16 5.2 M2.4 13.6 C6.4 13, 8.4 4.4, 15.6 4.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {showEdges && (
              <div className="tb-group">
                <button className={`tb-opt ${!cur.rounded ? 'on' : ''}`} title="Sharp edges" onClick={() => apply({ rounded: false })}>
                  <svg width="18" height="18" viewBox="0 0 18 18">
                    <path d="M4 15 V4 H15" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </button>
                <button className={`tb-opt ${cur.rounded ? 'on' : ''}`} title="Round edges" onClick={() => apply({ rounded: true })}>
                  <svg width="18" height="18" viewBox="0 0 18 18">
                    <path d="M4 15 V10 Q4 4 10 4 H15" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </Section>
      )}

      {showFont && (
        <Section title="Font size">
          <div className="tb-grid four">
            {FONT_SIZES.map((f) => (
              <button
                key={f.v}
                className={`tb-opt tb-txt ${near(fontSize, f.v) ? 'on' : ''}`}
                onClick={() => apply({ fontSize: f.v })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Opacity">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="tb-range"
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(cur.opacity * 100)}
            onChange={(e) => apply({ opacity: Number(e.target.value) / 100 })}
          />
          <span className="tb-val mono">{Math.round(cur.opacity * 100)}</span>
        </div>
      </Section>

      {sel.length > 0 && (
        <div className="tb-actions">
          <button className="tb-opt" title="Duplicate" onClick={() => duplicateInk(sel)}>
            <Copy size={14} />
          </button>
          <button
            className="tb-opt danger"
            title="Delete (Del)"
            onClick={() => {
              const app = useApp.getState()
              app.removeInk(sel.map((i) => i.id))
              app.setSelection(app.selection.filter((id) => !sel.some((i) => i.id === id)))
            }}
          >
            <Trash size={14} />
          </button>
          <span className="spacer" />
          <span className="tb-val">
            {sel.length} selected
          </span>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="tb-section">
      <div className="tb-title">{title}</div>
      {children}
    </div>
  )
}

function Swatches({ colors, value, onPick, allowNone }: { colors: string[]; value?: string; onPick: (c: string | undefined) => void; allowNone?: boolean }) {
  const v = value?.toLowerCase()
  const custom = !!v && v !== 'none' && !colors.includes(v)
  return (
    <div className="tb-swatches">
      {allowNone && (
        <button className={`swatch none ${!v || v === 'none' || v === 'transparent' ? 'on' : ''}`} title="None" onClick={() => onPick(undefined)}>
          <Ban size={11} />
        </button>
      )}
      {colors.map((c) => (
        <button key={c} className={`swatch ${v === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => onPick(c)} />
      ))}
      <label className={`swatch custom ${custom ? 'on' : ''}`} title="Custom color" style={custom ? { background: value } : undefined}>
        {!custom && <Pipette size={10} />}
        <input type="color" value={custom && /^#[0-9a-f]{6}$/i.test(value!) ? value : '#ffffff'} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  )
}
