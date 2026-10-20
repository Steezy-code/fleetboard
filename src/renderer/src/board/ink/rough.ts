// Tiny hand-drawn ("sloppy") path generator in the spirit of rough.js / Excalidraw.
// Everything is seeded from the ink item's id, so a shape wobbles the same way on every render.

import { pairs, pairsRound, quads, triplesRound } from '@shared/seq'

export type Pt = [number, number]

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 PRNG → [0, 1) */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export type Rand = () => number

const f = (n: number) => Math.round(n * 100) / 100

export interface RoughOpts {
  roughness: number
  bowing: number
  maxOffset: number
}
export const ROUGH: RoughOpts = { roughness: 1, bowing: 1, maxOffset: 2 }

const gainFor = (len: number) => (len < 200 ? 1 : len > 500 ? 0.4 : -0.0016668 * len + 1.233334)

function roughLine(r: Rand, x1: number, y1: number, x2: number, y2: number, o: RoughOpts, overlay: boolean, move = true): string {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const gain = gainFor(len)
  let offset = o.maxOffset
  if (offset * offset * 100 > len * len) offset = len / 10
  const v = overlay ? offset / 2 : offset
  const off = (x: number) => (r() * 2 - 1) * x * o.roughness * gain
  const diverge = 0.2 + r() * 0.2
  const midX = off((o.bowing * o.maxOffset * (y2 - y1)) / 200)
  const midY = off((o.bowing * o.maxOffset * (x1 - x2)) / 200)
  const sx = x1 + off(v)
  const sy = y1 + off(v)
  const c1x = midX + x1 + (x2 - x1) * diverge + off(v)
  const c1y = midY + y1 + (y2 - y1) * diverge + off(v)
  const c2x = midX + x1 + 2 * (x2 - x1) * diverge + off(v)
  const c2y = midY + y1 + 2 * (y2 - y1) * diverge + off(v)
  const ex = x2 + off(v)
  const ey = y2 + off(v)
  return `${move ? `M${f(sx)} ${f(sy)}` : ''}C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`
}

/** A hand-drawn straight line: two slightly different passes. */
export function roughSegment(r: Rand, a: Pt, b: Pt, double = true, o = ROUGH) {
  return roughLine(r, a[0], a[1], b[0], b[1], o, false) + (double ? roughLine(r, a[0], a[1], b[0], b[1], o, true) : '')
}

/**
 * Catmull-Rom-ish curve through points (rough.js `_curve`); first/last points are guides only.
 * Each window of four is (the guide before, this point, the next, the guide after), which is what
 * the index arithmetic this used to do was saying.
 */
function curveThroughGuided(pts: Pt[]): string {
  let d = ''
  for (const [prev, p, next, after] of quads(pts)) {
    if (!d) d = `M${f(p[0])} ${f(p[1])}`
    const b1: Pt = [p[0] + (next[0] - prev[0]) / 6, p[1] + (next[1] - prev[1]) / 6]
    const b2: Pt = [next[0] + (p[0] - after[0]) / 6, next[1] + (p[1] - after[1]) / 6]
    d += `C${f(b1[0])} ${f(b1[1])} ${f(b2[0])} ${f(b2[1])} ${f(next[0])} ${f(next[1])}`
  }
  return d
}

/** Smooth curve passing through every point. */
export function curveThrough(pts: Pt[]): string {
  const [first, second] = pts
  const last = pts[pts.length - 1]
  if (!first || !second || !last) return ''
  if (pts.length === 2) return `M${f(first[0])} ${f(first[1])}L${f(second[0])} ${f(second[1])}`
  // the ends repeated, as the guides the curve needs either side of a real point
  return curveThroughGuided([first, ...pts, last])
}

/** Hand-drawn smooth curve through points (multi-point arrows/lines with round edges). */
export function roughCurve(r: Rand, pts: Pt[], double = true): string {
  const pass = (amp: number) => curveThrough(pts.map(([x, y], i) => (i === 0 || i === pts.length - 1 ? [x + (r() - 0.5) * amp, y + (r() - 0.5) * amp] : [x + (r() * 2 - 1) * amp, y + (r() * 2 - 1) * amp]) as Pt))
  return pass(1.6) + (double ? pass(1.1) : '')
}

/** Hand-drawn ellipse (port of rough.js ellipse with two overlapping passes). */
export function roughEllipse(r: Rand, cx: number, cy: number, w: number, h: number, double = true, o = ROUGH): string {
  let rx = Math.abs(w / 2)
  let ry = Math.abs(h / 2)
  const psq = Math.sqrt(Math.PI * 2 * Math.sqrt((rx * rx + ry * ry) / 2))
  const stepCount = Math.ceil(Math.max(9, (9 / Math.sqrt(200)) * psq))
  const increment = (Math.PI * 2) / stepCount
  const gain = gainFor(Math.max(w, h))
  const offR = (min: number, max: number) => o.roughness * gain * (r() * (max - min) + min)
  const offO = (x: number) => offR(-x, x)
  rx += offO(rx * 0.05)
  ry += offO(ry * 0.05)
  const points = (offset: number, overlap: number): Pt[] => {
    const all: Pt[] = []
    const rad = offO(0.5) - Math.PI / 2
    all.push([offO(offset) + cx + 0.9 * rx * Math.cos(rad - increment), offO(offset) + cy + 0.9 * ry * Math.sin(rad - increment)])
    const end = Math.PI * 2 + rad - 0.01
    for (let a = rad; a < end; a += increment) all.push([offO(offset) + cx + rx * Math.cos(a), offO(offset) + cy + ry * Math.sin(a)])
    all.push([offO(offset) + cx + rx * Math.cos(rad + Math.PI * 2 + overlap * 0.5), offO(offset) + cy + ry * Math.sin(rad + Math.PI * 2 + overlap * 0.5)])
    all.push([offO(offset) + cx + 0.98 * rx * Math.cos(rad + overlap), offO(offset) + cy + 0.98 * ry * Math.sin(rad + overlap)])
    all.push([offO(offset) + cx + 0.9 * rx * Math.cos(rad + overlap * 0.5), offO(offset) + cy + 0.9 * ry * Math.sin(rad + overlap * 0.5)])
    return all
  }
  const p1 = curveThroughGuided(points(1, increment * offR(0.1, offR(0.4, 1))))
  return double ? p1 + curveThroughGuided(points(1.5, 0)) : p1
}

/** Corner tangent points for a polygon with rounded corners. */
function corners(pts: Pt[], radius: number) {
  return [...triplesRound(pts)].map(([prev, p, next]) => {
    const lp = Math.hypot(prev[0] - p[0], prev[1] - p[1]) || 1
    const ln = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1
    const rr = Math.min(radius, lp / 2, ln / 2)
    const tin: Pt = [p[0] + ((prev[0] - p[0]) / lp) * rr, p[1] + ((prev[1] - p[1]) / lp) * rr]
    const tout: Pt = [p[0] + ((next[0] - p[0]) / ln) * rr, p[1] + ((next[1] - p[1]) / ln) * rr]
    return { p, tin, tout, rr }
  })
}

/** Clean closed polygon, optionally with rounded corners. */
export function polygonPath(pts: Pt[], radius = 0): string {
  if (radius <= 0) return `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`
  const cs = corners(pts, radius)
  const [start] = cs
  if (!start) return ''
  let d = `M${f(start.tout[0])} ${f(start.tout[1])}`
  // every corner after the first, then back to the first
  for (const c of [...cs.slice(1), start]) {
    d += `L${f(c.tin[0])} ${f(c.tin[1])}Q${f(c.p[0])} ${f(c.p[1])} ${f(c.tout[0])} ${f(c.tout[1])}`
  }
  return d + 'Z'
}

/** Hand-drawn closed polygon (rect, diamond), optionally with rounded corners. */
export function roughPolygon(r: Rand, pts: Pt[], radius = 0, double = true): string {
  if (radius <= 0) {
    let d = ''
    for (const [a, b] of pairsRound(pts)) d += roughSegment(r, a, b, double)
    return d
  }
  const cs = corners(pts, radius)
  const j = (v: number, a = 1.2) => v + (r() * 2 - 1) * a
  let d = ''
  for (let pass = 0; pass < (double ? 2 : 1); pass++) {
    for (const [c, nx] of pairsRound(cs)) {
      d += roughLine(r, c.tout[0], c.tout[1], nx.tin[0], nx.tin[1], ROUGH, pass === 1)
      d += `Q${f(j(nx.p[0]))} ${f(j(nx.p[1]))} ${f(j(nx.tout[0], 0.6))} ${f(j(nx.tout[1], 0.6))}`
    }
  }
  return d
}

/** Hand-drawn open polyline (straight segments). */
export function roughPolyline(r: Rand, pts: Pt[], double = true): string {
  let d = ''
  for (const [a, b] of pairs(pts)) d += roughSegment(r, a, b, double)
  return d
}

/** Parallel hachure lines covering a bbox (clip them to the shape). */
export function hachure(r: Rand | null, x: number, y: number, w: number, h: number, gap: number, angleDeg = -41): string {
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const nx = -dy
  const ny = dx
  const cx = x + w / 2
  const cy = y + h / 2
  const R = Math.hypot(w, h) / 2 + gap
  let d = ''
  const o: RoughOpts = { roughness: 1, bowing: 0.6, maxOffset: 1.4 }
  for (let t = -R; t <= R; t += gap) {
    const px = cx + nx * t
    const py = cy + ny * t
    const x1 = px - dx * R
    const y1 = py - dy * R
    const x2 = px + dx * R
    const y2 = py + dy * R
    d += r ? roughLine(r, x1, y1, x2, y2, o, false) : `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`
  }
  return d
}
