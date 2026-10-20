import { pairs, pairsRound } from '@shared/seq'
import type { InkItem } from '@shared/types'
import { TITLE_SIZE } from './toInk'

// Export an ink figure: SVG (hand-drawn look reproduced with seeded jitter) → PNG via an offscreen
// canvas, and a native .excalidraw scene with bound text and arrow bindings.

type Pt = [number, number]
const SHAPES = new Set(['rect', 'ellipse', 'diamond'])
const BG = '#100e0d'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Small deterministic PRNG so exports look the same every time. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10000) / 10000
  }
}
const hash = (str: string) => {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

export function figureItems(ink: InkItem[], figureId: string) {
  return ink.filter((i) => i.figureId === figureId)
}

export function figureTitle(items: InkItem[]): string {
  const labels = items.filter((i) => i.kind === 'label' && i.text)
  labels.sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))
  return labels[0]?.text?.split('\n')[0] ?? 'diagram'
}

/** Labels may not be measured yet (w/h 0): estimate like the board does. */
const sized = (i: InkItem): InkItem => {
  if (i.kind !== 'label' || (i.w > 0 && i.h > 0)) return i
  const fs = i.fontSize ?? 20
  const lines = (i.text ?? '').split('\n')
  return { ...i, w: Math.max(1, ...lines.map((l) => l.length)) * fs * 0.56 + 4, h: lines.length * fs * 1.25 + 4 }
}

function bounds(items: InkItem[]) {
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const i of items.map(sized)) {
    const pts = i.points?.length ? i.points : [[i.x, i.y] as Pt, [i.x + i.w, i.y + i.h] as Pt]
    for (const [x, y] of pts) (l = Math.min(l, x)), (t = Math.min(t, y)), (r = Math.max(r, x)), (b = Math.max(b, y))
    if (!i.points?.length) (r = Math.max(r, i.x + i.w)), (b = Math.max(b, i.y + i.h))
  }
  return { l, t, r, b }
}

// ---------------------------------------------------------------- SVG

function roughLine(a: Pt, b: Pt, rand: () => number, amp: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const j = Math.min(amp, len * 0.02 + 0.6)
  const off = () => (rand() - 0.5) * 2 * j
  const nx = -(b[1] - a[1]) / (len || 1)
  const ny = (b[0] - a[0]) / (len || 1)
  const bow = (rand() - 0.5) * Math.min(len * 0.012, 3)
  const mx = (a[0] + b[0]) / 2 + nx * bow
  const my = (a[1] + b[1]) / 2 + ny * bow
  return `M${(a[0] + off()).toFixed(1)},${(a[1] + off()).toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${(b[0] + off()).toFixed(1)},${(b[1] + off()).toFixed(1)}`
}

function roughPoly(pts: Pt[], rand: () => number, amp = 1.6) {
  let d = ''
  for (let pass = 0; pass < 2; pass++) for (const [a, b] of pairsRound(pts)) d += roughLine(a, b, rand, amp) + ' '
  return d
}

function roundedRectPts(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const pts: Pt[] = []
  const c: [number, number, number][] = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI]
  ]
  for (const [cx, cy, a0] of c) for (let k = 0; k <= 3; k++) pts.push([cx + Math.cos(a0 + (k * Math.PI) / 6) * r, cy + Math.sin(a0 + (k * Math.PI) / 6) * r])
  return pts
}

function smoothClosed(pts: Pt[]) {
  const [first, second] = pts
  if (!first || !second) return ''
  let d = `M${((first[0] + second[0]) / 2).toFixed(1)},${((first[1] + second[1]) / 2).toFixed(1)}`
  // through every point and back round to the first, each curve ending halfway along the next edge
  const edges = [...pairsRound(pts)]
  for (const [p, n] of [...edges.slice(1), ...edges.slice(0, 1)]) {
    d += ` Q${p[0].toFixed(1)},${p[1].toFixed(1)} ${((p[0] + n[0]) / 2).toFixed(1)},${((p[1] + n[1]) / 2).toFixed(1)}`
  }
  return d + ' Z'
}

function roughEllipse(cx: number, cy: number, rx: number, ry: number, rand: () => number) {
  let d = ''
  for (let pass = 0; pass < 2; pass++) {
    const pts: Pt[] = []
    const n = 18
    const a0 = rand() * Math.PI * 2
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2
      const k = 1 + (rand() - 0.5) * 0.035
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
    }
    d += smoothClosed(pts) + ' '
  }
  return d
}

// the same shape as geometry.ts's inkPath, for the figure the exporter draws rather than the board
function smoothOpen(points: Pt[]) {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  if (points.length < 3) return `M${points.map((p) => p.join(',')).join(' L')}`
  let d = `M${first[0]},${first[1]}`
  for (const [[x, y], [nx, ny]] of pairs(points.slice(1))) d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`
  return `${d} L${last[0]},${last[1]}`
}

const FONT = `'Geist Variable', 'Inter', 'Helvetica Neue', Arial, sans-serif`
const SERIF = `'Fraunces Variable', Georgia, 'Times New Roman', serif`

function textSvg(text: string, x: number, y: number, size: number, color: string, anchor: 'start' | 'middle', lineH = 1.3, title = false) {
  const lines = text.split('\n')
  const family = title ? SERIF : FONT
  const style = title ? ' font-style="italic" font-weight="500"' : ' font-weight="500"'
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${esc(family)}" font-size="${size}" fill="${color}" text-anchor="${anchor}"${style}>${lines
    .map((l, i) => `<tspan x="${x.toFixed(1)}" dy="${i ? (size * lineH).toFixed(1) : 0}">${esc(l)}</tspan>`)
    .join('')}</text>`
}

export function figureToSvg(items: InkItem[], pad = 48): { svg: string; width: number; height: number } {
  const { l, t, r, b } = bounds(items)
  const width = Math.ceil(r - l + pad * 2)
  const height = Math.ceil(b - t + pad * 2)
  const ox = pad - l
  const oy = pad - t
  const T = (p: Pt): Pt => [p[0] + ox, p[1] + oy]
  const out: string[] = []

  for (const i of items) {
    const rand = rng(hash(i.id))
    const stroke = i.stroke
    const sw = i.width ?? 2
    const dash = i.dashed ? ` stroke-dasharray="${sw * 3} ${sw * 2.5}"` : ''
    const common = `stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash} opacity="${i.opacity ?? 1}"`
    const x = i.x + ox
    const y = i.y + oy
    switch (i.kind) {
      case 'rect': {
        const rr = i.rounded ? Math.min(12, i.w / 4, i.h / 4) : 0
        if (i.fill) out.push(`<rect x="${x}" y="${y}" width="${i.w}" height="${i.h}" rx="${rr}" fill="${i.fill}" stroke="none"/>`)
        if (i.sloppy && !i.dashed) {
          const pts = rr ? roundedRectPts(x, y, i.w, i.h, rr) : ([[x, y], [x + i.w, y], [x + i.w, y + i.h], [x, y + i.h]] as Pt[])
          out.push(`<path d="${roughPoly(pts, rand, rr ? 0.9 : 1.6)}" fill="none" ${common}/>`)
        } else out.push(`<rect x="${x}" y="${y}" width="${i.w}" height="${i.h}" rx="${rr}" fill="none" ${common}/>`)
        break
      }
      case 'ellipse': {
        const cx = x + i.w / 2
        const cy = y + i.h / 2
        if (i.fill) out.push(`<ellipse cx="${cx}" cy="${cy}" rx="${i.w / 2}" ry="${i.h / 2}" fill="${i.fill}" stroke="none"/>`)
        if (i.sloppy) out.push(`<path d="${roughEllipse(cx, cy, i.w / 2, i.h / 2, rand)}" fill="none" ${common}/>`)
        else out.push(`<ellipse cx="${cx}" cy="${cy}" rx="${i.w / 2}" ry="${i.h / 2}" fill="none" ${common}/>`)
        break
      }
      case 'diamond': {
        const pts: Pt[] = [
          [x + i.w / 2, y],
          [x + i.w, y + i.h / 2],
          [x + i.w / 2, y + i.h],
          [x, y + i.h / 2]
        ]
        if (i.fill) out.push(`<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${i.fill}" stroke="none"/>`)
        if (i.sloppy) out.push(`<path d="${roughPoly(pts, rand)}" fill="none" ${common}/>`)
        else out.push(`<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" ${common}/>`)
        break
      }
      case 'line':
      case 'arrow': {
        const pts = (i.points ?? []).map(T)
        const [p0, p1] = pts
        const e = pts[pts.length - 1]
        const a = pts[pts.length - 2]
        // two points is the least a line can have, and then both ends of the head exist as well
        if (!p0 || !p1 || !e || !a) break
        if (i.sloppy && pts.length === 2) out.push(`<path d="${roughLine(p0, p1, rand, 1.2)} ${roughLine(p0, p1, rand, 1.2)}" fill="none" ${common}/>`)
        else out.push(`<path d="${smoothOpen(pts)}" fill="none" ${common}/>`)
        if (i.kind === 'arrow') {
          const ang = Math.atan2(e[1] - a[1], e[0] - a[0])
          const len = Math.max(10, sw * 5.5)
          const h1: Pt = [e[0] - Math.cos(ang - 0.45) * len, e[1] - Math.sin(ang - 0.45) * len]
          const h2: Pt = [e[0] - Math.cos(ang + 0.45) * len, e[1] - Math.sin(ang + 0.45) * len]
          out.push(`<path d="M${h1[0].toFixed(1)},${h1[1].toFixed(1)} L${e[0].toFixed(1)},${e[1].toFixed(1)} L${h2[0].toFixed(1)},${h2[1].toFixed(1)}" fill="none" ${common.replace(dash, '')}/>`)
        }
        break
      }
      case 'path': {
        const pts = (i.points ?? []).map(T)
        if (pts.length > 1) out.push(`<path d="${smoothOpen(pts)}" fill="none" ${common}/>`)
        break
      }
    }
    if (i.text && SHAPES.has(i.kind)) {
      const size = i.fontSize ?? 15
      const lines = i.text.split('\n')
      const total = lines.length * size * 1.3
      out.push(textSvg(i.text, x + i.w / 2, y + i.h / 2 - total / 2 + size * 0.95, size, i.stroke, 'middle'))
    } else if (i.text && i.kind === 'label') {
      const size = i.fontSize ?? 15
      out.push(textSvg(i.text, x, y + size, size, i.stroke, 'start', 1.3, size >= TITLE_SIZE - 4))
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${BG}"/>${out.join('')}</svg>`
  return { svg, width, height }
}

/** Rasterize at `scale`× and return base64 PNG (no data: prefix). */
export function figureToPngBase64(items: InkItem[], scale = 2): Promise<string> {
  const { svg, width, height } = figureToSvg(items)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(width * scale)
      canvas.height = Math.ceil(height * scale)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = BG
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0, width, height)
      // the base64 payload, which is everything after the data URL's comma
      const url = canvas.toDataURL('image/png')
      resolve(url.slice(url.indexOf(',') + 1))
    }
    img.onerror = () => reject(new Error('Could not rasterize the figure'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
}

// ---------------------------------------------------------------- Excalidraw

const rid = (rand: () => number) => Math.floor(rand() * 2 ** 31)
const eid = (() => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return () => Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
})()

export function figureToExcalidraw(items: InkItem[]) {
  const now = Date.now()
  const rand = rng(now & 0xffffffff)
  const elements: any[] = []
  const shapeEls = new Map<string, any>()
  const base = (i: InkItem, type: string, extra: Record<string, any>): Record<string, any> => ({
    id: eid(),
    type,
    x: i.x,
    y: i.y,
    width: i.w,
    height: i.h,
    angle: 0,
    strokeColor: i.stroke,
    backgroundColor: i.fill ?? 'transparent',
    fillStyle: 'solid',
    strokeWidth: i.width ?? 2,
    strokeStyle: i.dashed ? 'dashed' : 'solid',
    roughness: i.sloppy ? 1 : 0,
    opacity: Math.round((i.opacity ?? 1) * 100),
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rid(rand),
    version: 1,
    versionNonce: rid(rand),
    isDeleted: false,
    boundElements: [] as any[],
    updated: now,
    link: null,
    locked: false,
    ...extra
  })
  const textEl = (text: string, x: number, y: number, size: number, color: string, containerId: string | null, align: 'left' | 'center'): Record<string, any> => {
    const lines = text.split('\n')
    const w = Math.max(...lines.map((l) => l.length)) * size * 0.6
    const h = lines.length * size * 1.25
    return {
      ...base({ id: '', kind: 'label', x, y, w, h, stroke: color, width: 1 } as InkItem, 'text', {}),
      x: align === 'center' ? x - w / 2 : x,
      y: containerId ? y - h / 2 : y,
      width: w,
      height: h,
      boundElements: null,
      text,
      originalText: text,
      fontSize: size,
      fontFamily: 1,
      textAlign: align,
      verticalAlign: containerId ? 'middle' : 'top',
      containerId,
      autoResize: true,
      lineHeight: 1.25,
      baseline: Math.round(size * 0.9)
    }
  }

  // shapes first so arrows can bind to them
  for (const i of items) {
    if (!SHAPES.has(i.kind)) continue
    const type = i.kind === 'rect' ? 'rectangle' : i.kind
    const el = base(i, type, { roundness: i.rounded && i.kind !== 'ellipse' ? { type: i.kind === 'diamond' ? 2 : 3 } : null })
    elements.push(el)
    shapeEls.set(i.id, { el, item: i })
    if (i.text) {
      const t = textEl(i.text, i.x + i.w / 2, i.y + i.h / 2, i.fontSize ?? 15, i.stroke, el.id, 'center')
      el.boundElements.push({ type: 'text', id: t.id })
      elements.push(t)
    }
  }
  // The shape an arrow end touches: the smallest one around the point, never a dashed group frame
  // (frames contain whole clusters, so matching them would bind both ends of an inner arrow to the frame).
  const hit = (p: Pt) => {
    const m = 12
    let best: any = null
    let bestArea = Infinity
    for (const { el, item } of shapeEls.values()) {
      if (item.dashed) continue
      if (p[0] < item.x - m || p[0] > item.x + item.w + m || p[1] < item.y - m || p[1] > item.y + item.h + m) continue
      const area = item.w * item.h
      if (area < bestArea) {
        best = el
        bestArea = area
      }
    }
    return best
  }

  // merge "path body + arrow tip" pairs back into one multi-point arrow
  const arrows = items.filter((i) => i.kind === 'arrow' && i.points && i.points.length >= 2)
  const used = new Set<string>()
  const key = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`
  // every arrow was filtered to two points or more above, so each one has a start
  const arrowByStart = new Map(arrows.flatMap((a) => (a.points?.[0] ? [[key(a.points[0]), a] as const] : [])))

  const linear = (i: InkItem, pts: Pt[], type: 'arrow' | 'line', head: boolean) => {
    const start = pts[0]
    const end = pts[pts.length - 1]
    if (!start || !end) return
    const [x0, y0] = start
    const rel = pts.map(([x, y]): Pt => [x - x0, y - y0])
    const xs = rel.map((p) => p[0])
    const ys = rel.map((p) => p[1])
    const el = base(i, type, {
      x: x0,
      y: y0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points: rel,
      roundness: pts.length > 2 ? { type: 2 } : null,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: head ? 'arrow' : null,
      elbowed: false
    })
    if (type === 'arrow') {
      const s = hit(start)
      const e = hit(end)
      if (s) {
        el.startBinding = { elementId: s.id, focus: 0, gap: 6 }
        s.boundElements.push({ type: 'arrow', id: el.id })
      }
      if (e && e !== s) {
        el.endBinding = { elementId: e.id, focus: 0, gap: 6 }
        e.boundElements.push({ type: 'arrow', id: el.id })
      }
    }
    elements.push(el)
  }

  for (const i of items) {
    if (i.kind === 'path' && i.points?.length) {
      const pathEnd = i.points[i.points.length - 1]
      const tip = pathEnd ? arrowByStart.get(key(pathEnd)) : undefined
      const tipEnd = tip?.points?.at(-1)
      const start = i.points[0]
      if (tip && tipEnd && i.figureId && tip.figureId === i.figureId) {
        used.add(tip.id)
        linear(i, [...i.points, tipEnd], 'arrow', true)
      } else if (start) {
        const [x0, y0] = start
        elements.push(
          base(i, 'freedraw', {
            x: x0,
            y: y0,
            points: i.points.map(([x, y]) => [x - x0, y - y0]),
            pressures: [],
            simulatePressure: true,
            lastCommittedPoint: null
          })
        )
      }
    }
  }
  for (const i of items) {
    if (i.kind === 'arrow' && i.points && !used.has(i.id)) linear(i, i.points, 'arrow', true)
    else if (i.kind === 'line' && i.points) linear(i, i.points, 'line', false)
    else if (i.kind === 'label' && i.text) elements.push(textEl(i.text, i.x, i.y, i.fontSize ?? 15, i.stroke, null, 'left'))
  }
  for (const el of elements) if (Array.isArray(el.boundElements) && !el.boundElements.length) el.boundElements = null

  return {
    type: 'excalidraw',
    version: 2,
    source: 'fleetboard',
    elements,
    appState: { viewBackgroundColor: '#121212', gridSize: null, theme: 'dark' },
    files: {}
  }
}
