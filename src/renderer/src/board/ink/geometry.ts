import { pairs, pairsRound } from '@shared/seq'
import type { InkItem } from '@shared/types'
import type { Pt } from './rough'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const isClosedShape = (k: InkItem['kind']) => k === 'rect' || k === 'ellipse' || k === 'diamond'
export const isLinear = (k: InkItem['kind']) => k === 'line' || k === 'arrow' || k === 'path'

/** Corner radius used for rounded rects / diamonds. */
export const cornerRadius = (w: number, h: number) => Math.min(24, Math.min(Math.abs(w), Math.abs(h)) * 0.22)

export const diamondPts = (i: Box): Pt[] => [
  [i.x + i.w / 2, i.y],
  [i.x + i.w, i.y + i.h / 2],
  [i.x + i.w / 2, i.y + i.h],
  [i.x, i.y + i.h / 2]
]
export const rectPts = (i: Box): Pt[] => [
  [i.x, i.y],
  [i.x + i.w, i.y],
  [i.x + i.w, i.y + i.h],
  [i.x, i.y + i.h]
]

/** Points of a linear item; falls back to its box diagonal. */
/** A line's points: its own if it has any, else the two corners of its box — never none. */
export function linePoints(i: InkItem): [Pt, ...Pt[]] {
  if (i.points && i.points.length) return i.points as [Pt, ...Pt[]]
  return [
    [i.x, i.y],
    [i.x + i.w, i.y + i.h]
  ]
}

export function bboxOfPoints(pts: Pt[]): Box {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Rough width/height for a label that has no measured box yet. */
export function labelSize(i: InkItem): { w: number; h: number } {
  const fs = i.fontSize ?? 20
  const lines = (i.text ?? '').split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  return { w: i.w > 0 ? i.w : longest * fs * 0.56 + 4, h: i.h > 0 ? i.h : lines.length * fs * 1.25 + 4 }
}

/** World-space bounds of an item, including the arrowhead / label estimate. */
export function itemBox(i: InkItem): Box {
  if (i.kind === 'label') {
    const s = labelSize(i)
    return { x: i.x, y: i.y, w: s.w, h: s.h }
  }
  if (isLinear(i.kind) && i.points?.length) return bboxOfPoints(i.points as Pt[])
  return { x: Math.min(i.x, i.x + i.w), y: Math.min(i.y, i.y + i.h), w: Math.abs(i.w), h: Math.abs(i.h) }
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const b = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: r - x, h: b - y }
}

function distToSeg(px: number, py: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}
const distToPolyline = (px: number, py: number, pts: Pt[], closed = false) => {
  let d = Infinity
  // round the shape when it is closed, which is the same segments plus the one back to the start
  for (const [a, b] of closed && pts.length > 2 ? pairsRound(pts) : pairs(pts)) d = Math.min(d, distToSeg(px, py, a, b))
  const only = pts.length === 1 ? pts[0] : undefined
  if (only) d = Math.hypot(px - only[0], py - only[1])
  return d
}

/** Is world point (x, y) on the item? `tol` is in world units. */
export function hitItem(i: InkItem, x: number, y: number, tol: number): boolean {
  const t = tol + i.width / 2
  const b = itemBox(i)
  if (x < b.x - t - 30 || x > b.x + b.w + t + 30 || y < b.y - t - 30 || y > b.y + b.h + t + 30) return false
  const solid = !!(i.fill && i.fill !== 'none' && i.fill !== 'transparent') || !!i.text
  switch (i.kind) {
    case 'label':
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol
    case 'rect': {
      if (solid && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true
      return distToPolyline(x, y, rectPts(b), true) <= t
    }
    case 'diamond': {
      const pts = diamondPts(b)
      if (solid) {
        const nx = Math.abs(x - (b.x + b.w / 2)) / (b.w / 2 || 1)
        const ny = Math.abs(y - (b.y + b.h / 2)) / (b.h / 2 || 1)
        if (nx + ny <= 1) return true
      }
      return distToPolyline(x, y, pts, true) <= t
    }
    case 'ellipse': {
      const rx = b.w / 2 || 1
      const ry = b.h / 2 || 1
      const nx = (x - (b.x + rx)) / rx
      const ny = (y - (b.y + ry)) / ry
      const r = Math.hypot(nx, ny)
      if (solid && r <= 1) return true
      // approximate distance to the outline in world units
      return Math.abs(r - 1) * Math.min(rx, ry) <= t
    }
    default: {
      const pts = linePoints(i)
      if (distToPolyline(x, y, pts) <= t) return true
      if (i.text && (i.kind === 'line' || i.kind === 'arrow')) {
        const m = midPoint(pts)
        return Math.abs(x - m[0]) < 60 && Math.abs(y - m[1]) < 16
      }
      return false
    }
  }
}

/** Topmost item under a point. */
export function hitTest(ink: InkItem[], x: number, y: number, tol: number): InkItem | null {
  // last drawn is topmost
  return ink.findLast((i) => hitItem(i, x, y, tol)) ?? null
}

/**
 * Point halfway along a polyline. Takes a polyline with at least one point, because there is no
 * honest answer for none: it used to return pts[pts.length - 1] — undefined, typed Pt — and the
 * callers read [0] and [1] off it, which is a label drawn at NaN or a throw depending on the caller.
 */
export function midPoint(pts: [Pt, ...Pt[]]): Pt {
  if (pts.length === 1) return pts[0]
  const segs = [...pairs(pts)].map(([a, b]) => ({ a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }))
  let acc = segs.reduce((sum, sg) => sum + sg.len, 0) / 2
  for (const { a, b, len } of segs) {
    if (acc <= len) {
      const t = len ? acc / len : 0
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    acc -= len
  }
  // every segment walked and nothing matched: floating point, so the end of the line
  return pts[pts.length - 1] ?? pts[0]
}

/** The area where a shape's text is laid out. */
export function textBox(i: InkItem): Box {
  const b = itemBox(i)
  switch (i.kind) {
    case 'ellipse': {
      const w = b.w * 0.74
      const h = b.h * 0.74
      return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h }
    }
    case 'diamond': {
      const w = b.w * 0.58
      const h = b.h * 0.58
      return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h }
    }
    case 'rect':
      return { x: b.x + 8, y: b.y + 6, w: Math.max(10, b.w - 16), h: Math.max(10, b.h - 12) }
    case 'line':
    case 'arrow': {
      const m = midPoint(linePoints(i))
      return { x: m[0] - 140, y: m[1] - 60, w: 280, h: 120 }
    }
    default:
      return b
  }
}

/** Two arrowhead barbs at the end of the polyline. */
export function arrowHead(pts: Pt[], width: number): [Pt, Pt, Pt] | null {
  const tip = pts.length > 1 ? pts[pts.length - 1] : undefined
  if (!tip) return null
  // walk back to a point far enough away for a stable direction
  const crowding = (p: Pt | undefined) => !!p && Math.hypot(tip[0] - p[0], tip[1] - p[1]) < 6
  let k = pts.length - 2
  while (k > 0 && crowding(pts[k])) k--
  const from = pts[k]
  if (!from) return null
  const dx = tip[0] - from[0]
  const dy = tip[1] - from[1]
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  let total = 0
  for (const [a, b] of pairs(pts)) total += Math.hypot(b[0] - a[0], b[1] - a[1])
  const head = Math.max(6, Math.min(total * 0.4, 12 + width * 3.2))
  const ang = Math.atan2(dy, dx)
  const spread = Math.PI / 7.5
  const a: Pt = [tip[0] - head * Math.cos(ang - spread), tip[1] - head * Math.sin(ang - spread)]
  const b: Pt = [tip[0] - head * Math.cos(ang + spread), tip[1] - head * Math.sin(ang + spread)]
  return [a, tip, b]
}

/** Smoothed SVG path through freehand points (quadratic midpoints). */
export function inkPath(points: [number, number][]) {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  if (points.length < 3) return `M${points.map((p) => p.join(',')).join(' L')}`
  let d = `M${first[0]},${first[1]}`
  // a quadratic through each interior point, ending halfway to the next one
  for (const [[x, y], [nx, ny]] of pairs(points.slice(1))) d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`
  return `${d} L${last[0]},${last[1]}`
}
