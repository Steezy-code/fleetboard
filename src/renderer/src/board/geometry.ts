import type { Group } from '@shared/types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
export const snap = (v: number, g = 8) => Math.round(v / g) * g

/** Group under a point, preferring the smallest (innermost). */
export const groupAt = (groups: Group[], x: number, y: number) =>
  groups.filter((g) => contains(g, x, y)).sort((a, b) => a.w * a.h - b.w * b.h)[0]

/** Point on the border of a rect in the direction of another point (for wire endpoints). */
export function edgePoint(r: Rect, toward: { x: number; y: number }) {
  const c = center(r)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  const sx = r.w / 2 / Math.abs(dx || 1e-9)
  const sy = r.h / 2 / Math.abs(dy || 1e-9)
  const s = Math.min(sx, sy)
  return { x: c.x + dx * s, y: c.y + dy * s }
}
