import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import type { InkItem } from '@shared/types'
import { useApp } from '../../state/store'
import { curveThrough, hashStr, hachure, polygonPath, rng, roughCurve, roughEllipse, roughPolygon, roughPolyline, roughSegment } from './rough'
import { arrowHead, cornerRadius, diamondPts, inkPath, isClosedShape, itemBox, labelSize, linePoints, rectPts, textBox } from './geometry'

const hasAlpha = (c: string) => /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.test(c) || /^(rgba|hsla)\(/i.test(c) || c === 'transparent'
export const hasFill = (i: InkItem) => !!i.fill && i.fill !== 'none' && i.fill !== 'transparent'

/** Clean outline of a closed shape (fill, clip, architect stroke). */
export function outlinePath(i: InkItem): string {
  const b = itemBox(i)
  const r = i.rounded ? cornerRadius(b.w, b.h) : 0
  if (i.kind === 'rect') return polygonPath(rectPts(b), r)
  if (i.kind === 'diamond') return polygonPath(diamondPts(b), r * 0.7)
  if (i.kind === 'ellipse') {
    const rx = b.w / 2
    const ry = b.h / 2
    const cx = b.x + rx
    const cy = b.y + ry
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
  }
  return ''
}

/** Clean path of a linear item. */
export function linePath(i: InkItem): string {
  const pts = linePoints(i)
  if (i.kind === 'path') return inkPath(pts)
  if (i.rounded && pts.length > 2) return curveThrough(pts)
  return `M${pts.map((p) => `${p[0]} ${p[1]}`).join('L')}`
}

interface Built {
  stroke: string
  head?: string
  fill?: string
  hachure?: string
}

function build(i: InkItem): Built {
  const sloppy = !!i.sloppy && i.kind !== 'path'
  const double = !i.dashed
  const r = rng(hashStr(i.id))
  const b = itemBox(i)
  const out: Built = { stroke: '' }
  if (isClosedShape(i.kind)) {
    const rad = i.rounded ? cornerRadius(b.w, b.h) : 0
    if (!sloppy) out.stroke = outlinePath(i)
    else if (i.kind === 'rect') out.stroke = roughPolygon(r, rectPts(b), rad, double)
    else if (i.kind === 'diamond') out.stroke = roughPolygon(r, diamondPts(b), rad * 0.7, double)
    else out.stroke = roughEllipse(r, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, double)
    if (hasFill(i)) {
      out.fill = outlinePath(i)
      if (sloppy) {
        const gap = Math.max(8, Math.min(16, i.width * 4.5))
        out.hachure = hachure(rng(hashStr(i.id + 'h')), b.x, b.y, b.w, b.h, gap)
      }
    }
  } else if (i.kind === 'line' || i.kind === 'arrow' || i.kind === 'path') {
    const pts = linePoints(i)
    if (!sloppy) out.stroke = linePath(i)
    else if (i.rounded && pts.length > 2) out.stroke = roughCurve(r, pts, double)
    else out.stroke = roughPolyline(r, pts, double)
    if (i.kind === 'arrow') {
      const h = arrowHead(pts, i.width)
      if (h) {
        const [a, tip, c] = h
        out.head = sloppy ? roughSegment(r, a, tip, false) + roughSegment(r, tip, c, false) : `M${a[0]} ${a[1]}L${tip[0]} ${tip[1]}L${c[0]} ${c[1]}`
      }
    }
  }
  return out
}

const FONT_DEFAULT = 16

/** The hand-drawn look also gets a handwritten-ish font. */
export const inkFontClass = (i: InkItem) => (i.sloppy === false ? 'sans' : 'hand')

export const InkShape = memo(function InkShape({ item, hideText }: { item: InkItem; hideText?: boolean }) {
  const built = useMemo(() => build(item), [item])
  const dash = item.dashed ? `${4 + item.width * 2.5} ${4 + item.width * 2.6}` : undefined
  const fillOpacity = item.fill && hasAlpha(item.fill) ? 1 : 0.22
  const clipId = `inkclip-${item.id}`
  return (
    <g opacity={item.opacity ?? 1} className="ink-item" data-ink-id={item.id}>
      {item.kind !== 'label' && (
        <>
          {built.fill && <path d={built.fill} fill={item.fill} fillOpacity={fillOpacity} stroke="none" />}
          {built.hachure && (
            <>
              <clipPath id={clipId}>
                <path d={built.fill} />
              </clipPath>
              <path
                d={built.hachure}
                clipPath={`url(#${clipId})`}
                fill="none"
                stroke={item.fill}
                strokeOpacity={0.5}
                strokeWidth={Math.max(1, item.width / 2)}
                strokeLinecap="round"
              />
            </>
          )}
          <path
            d={built.stroke}
            fill="none"
            stroke={item.stroke}
            strokeWidth={item.width}
            strokeDasharray={dash}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {built.head && <path d={built.head} fill="none" stroke={item.stroke} strokeWidth={item.width} strokeLinecap="round" strokeLinejoin="round" />}
        </>
      )}
      {!hideText && (item.kind === 'label' ? <InkLabel item={item} /> : item.text ? <ShapeText item={item} /> : null)}
    </g>
  )
})

function ShapeText({ item }: { item: InkItem }) {
  const tb = textBox(item)
  const linear = item.kind === 'line' || item.kind === 'arrow'
  return (
    <foreignObject x={tb.x} y={tb.y} width={tb.w} height={tb.h} style={{ overflow: 'visible' }}>
      <div
        className={`ink-text ${inkFontClass(item)} ${linear ? 'on-line' : ''}`}
        style={{ color: item.stroke, fontSize: item.fontSize ?? FONT_DEFAULT }}
      >
        <span>{item.text}</span>
      </div>
    </foreignObject>
  )
}

function InkLabel({ item }: { item: InkItem }) {
  const ref = useRef<HTMLDivElement>(null)
  const measured = item.w > 0 && item.h > 0
  // Labels from the diagram studio may come without a size: measure once and store it.
  useLayoutEffect(() => {
    if (measured || !ref.current || !item.text) return
    let alive = true
    // wait for the ink font, otherwise the fallback font gives a wrong size
    document.fonts.ready.then(() => {
      const el = ref.current
      if (!alive || !el) return
      const w = Math.ceil(el.offsetWidth) + 2
      const h = Math.ceil(el.offsetHeight)
      if (w > 2 && h > 0) useApp.getState().updateInk(item.id, { w, h })
    })
    return () => {
      alive = false
    }
  }, [measured, item.id, item.text, item.fontSize])
  const fs = item.fontSize ?? 20
  if (!measured) {
    return (
      <foreignObject x={item.x} y={item.y} width={4000} height={2000} style={{ overflow: 'visible' }}>
        <div ref={ref} className={`ink-text ink-label free ${inkFontClass(item)}`} style={{ color: item.stroke, fontSize: fs }}>
          {item.text}
        </div>
      </foreignObject>
    )
  }
  const s = labelSize(item)
  return (
    <foreignObject x={item.x} y={item.y} width={s.w} height={s.h} style={{ overflow: 'visible' }}>
      <div className={`ink-text ink-label ${inkFontClass(item)}`} style={{ color: item.stroke, fontSize: fs }}>
        {item.text}
      </div>
    </foreignObject>
  )
}
