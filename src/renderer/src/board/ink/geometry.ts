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
export function linePoints(i: InkItem): Pt[] {
  if (i.points && i.points.length) return i.points as Pt[]
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
  for (let k = 0; k + 1 < pts.length; k++) d = Math.min(d, distToSeg(px, py, pts[k], pts[k + 1]))
  if (closed && pts.length > 2) d = Math.min(d, distToSeg(px, py, pts[pts.length - 1], pts[0]))
  if (pts.length === 1) d = Math.hypot(px - pts[0][0], py - pts[0][1])
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
  for (let k = ink.length - 1; k >= 0; k--) if (hitItem(ink[k], x, y, tol)) return ink[k]
  return null
}

/** Point halfway along a polyline. */
export function midPoint(pts: Pt[]): Pt {
  if (pts.length === 1) return pts[0]
  const lens: number[] = []
  let total = 0
  for (let k = 0; k + 1 < pts.length; k++) {
    const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
    lens.push(l)
    total += l
  }
  let acc = total / 2
  for (let k = 0; k < lens.length; k++) {
    if (acc <= lens[k]) {
      const t = lens[k] ? acc / lens[k] : 0
      return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t]
    }
    acc -= lens[k]
  }
  return pts[pts.length - 1]
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
  if (pts.length < 2) return null
  const tip = pts[pts.length - 1]
  // walk back to a point far enough away for a stable direction
  let k = pts.length - 2
  while (k > 0 && Math.hypot(tip[0] - pts[k][0], tip[1] - pts[k][1]) < 6) k--
  const from = pts[k]
  const dx = tip[0] - from[0]
  const dy = tip[1] - from[1]
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  let total = 0
  for (let j = 0; j + 1 < pts.length; j++) total += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1])
  const head = Math.max(6, Math.min(total * 0.4, 12 + width * 3.2))
  const ang = Math.atan2(dy, dx)
  const spread = Math.PI / 7.5
  const a: Pt = [tip[0] - head * Math.cos(ang - spread), tip[1] - head * Math.sin(ang - spread)]
  const b: Pt = [tip[0] - head * Math.cos(ang + spread), tip[1] - head * Math.sin(ang + spread)]
  return [a, tip, b]
}

/** Smoothed SVG path through freehand points (quadratic midpoints). */
export function inkPath(points: [number, number][]) {
  if (!points.length) return ''
  if (points.length < 3) return `M${points.map((p) => p.join(',')).join(' L')}`
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`
  }
  const last = points[points.length - 1]
  return `${d} L${last[0]},${last[1]}`
}
