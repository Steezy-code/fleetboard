import type { InkItem } from '@shared/types'
import { uid } from '../../lib/api'
import type { Layout, Pt } from './layout'
import type { DShape } from './spec'

// Layout → loose ink figures on the board. Everything shares a figureId so the figure can be
// selected, exported and found again.

export type DiagramStyle = 'ink' | 'colorful'

export const INK = '#f2ede6'
const INK_SOFT = '#c9c0b6'
const INK_DIM = '#8f857b'
/** role-like tints for the Colorful style */
export const PALETTE: readonly [string, ...string[]] = ['#ff7a45', '#60a5fa', '#3ecf8e', '#c084fc', '#f5b740', '#2dd4bf', '#f43f5e', '#a8a29e']

/** A colour per index, the palette starting over when there are more of them than colours. */
const hue = (i: number) => PALETTE[i % PALETTE.length] ?? PALETTE[0]

export const TITLE_SIZE = 30
const NODE_SIZE = 15
const EDGE_SIZE = 12.5
const GROUP_SIZE = 12.5

const bbox = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Width/height of a text label in board units (rough, matches the board's UI font). */
export function textBox(text: string, size: number) {
  const lines = text.split('\n')
  return { w: Math.ceil(Math.max(...lines.map((l) => l.length)) * size * 0.56) + 8, h: Math.ceil(lines.length * size * 1.3) + 4 }
}

export function figureSize(l: Layout) {
  const t = textBox(l.title, TITLE_SIZE)
  return { w: Math.max(l.width, t.w), h: l.height + t.h + 34 }
}

export function layoutToInk(l: Layout, origin: { x: number; y: number }, style: DiagramStyle, figureId = uid('fig')): InkItem[] {
  const colorful = style === 'colorful'
  const items: InkItem[] = []
  // labels have w/h 0: the board measures them on first render
  const base = { width: 2, sloppy: true, rounded: true, figureId, opacity: 1 }
  const titleBox = textBox(l.title, TITLE_SIZE)
  const ox = origin.x
  const oy = origin.y + titleBox.h + 34
  const P = (p: Pt): Pt => [Math.round(p[0] + ox), Math.round(p[1] + oy)]

  // colors: per group in Colorful, or per branch for mind maps, or by shape
  const groupColor = new Map(l.groups.map((g, i) => [g.id, hue(i)]))
  const branchColor = new Map<string, string>()
  if (l.dir === 'radial') {
    const root = l.nodes.find((n) => n.depth === 0)
    const adj = new Map<string, string[]>()
    for (const e of l.edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
    }
    const first = l.nodes.filter((n) => n.depth === 1)
    first.forEach((n, i) => {
      const c = hue(i)
      const stack = [n.id]
      while (stack.length) {
        const v = stack.pop()!
        if (branchColor.has(v) || v === root?.id) continue
        branchColor.set(v, c)
        for (const u of adj.get(v) ?? []) if ((l.nodes.find((x) => x.id === u)?.depth ?? 0) > (l.nodes.find((x) => x.id === v)?.depth ?? 0)) stack.push(u)
      }
    })
  }
  const shapeColor: Record<DShape, string> = { rect: hue(0), ellipse: hue(2), diamond: hue(4) }
  const colorOf = (id: string) => {
    const n = l.nodes.find((x) => x.id === id)!
    if (l.dir === 'radial') return n.depth === 0 ? hue(0) : branchColor.get(id) ?? hue(1)
    return (n.group && groupColor.get(n.group)) || shapeColor[n.shape]
  }
  const alpha = (hex: string, a: string) => `${hex}${a}`

  // title
  items.push({
    id: uid('ink'),
    kind: 'label',
    x: Math.round(ox),
    y: Math.round(origin.y),
    w: 0,
    h: 0,
    stroke: INK,
    width: 1,
    text: l.title,
    fontSize: TITLE_SIZE,
    figureId
  })

  // group containers (behind everything)
  for (const g of l.groups) {
    const c = colorful ? groupColor.get(g.id)! : INK_DIM
    items.push({
      ...base,
      id: uid('ink'),
      kind: 'rect',
      x: Math.round(g.x + ox),
      y: Math.round(g.y + oy),
      w: Math.round(g.w),
      h: Math.round(g.h),
      stroke: c,
      fill: colorful ? alpha(c, '0f') : undefined,
      width: 1.5,
      dashed: true
    })
    const label = g.label.toUpperCase()
    items.push({
      id: uid('ink'),
      kind: 'label',
      x: Math.round(g.x + ox + 14),
      y: Math.round(g.y + oy + 9),
      w: 0,
      h: 0,
      stroke: colorful ? c : INK_SOFT,
      width: 1,
      text: label,
      fontSize: GROUP_SIZE,
      figureId
    })
  }

  // edges
  const edgeColor = colorful ? INK_SOFT : INK
  for (const e of l.edges) {
    const pts = e.points.map(P)
    const stroke = colorful && l.dir === 'radial' ? colorOf(e.to) : edgeColor
    if (!e.directed) {
      items.push({ ...base, id: uid('ink'), kind: 'line', points: pts, ...bbox(pts), stroke })
    } else {
      // long edges keep their lane points; the board draws a rounded arrow through them
      items.push({ ...base, id: uid('ink'), kind: 'arrow', points: pts, ...bbox(pts), stroke })
    }
  }

  // nodes
  for (const n of l.nodes) {
    const c = colorful ? colorOf(n.id) : INK
    items.push({
      ...base,
      id: uid('ink'),
      kind: n.shape,
      x: Math.round(n.x + ox),
      y: Math.round(n.y + oy),
      w: n.w,
      h: n.h,
      stroke: c,
      fill: colorful ? alpha(c, '22') : undefined,
      width: n.depth === 0 ? 2.5 : 2,
      text: n.lines.join('\n'),
      fontSize: n.depth === 0 ? 17 : NODE_SIZE
    })
  }

  // edge labels, beside the midpoint
  for (const e of l.edges) {
    if (!e.label || !e.labelAt) continue
    const [mx, my] = P(e.labelAt)
    const tb = textBox(e.label, EDGE_SIZE)
    const lr = l.dir === 'LR'
    items.push({
      id: uid('ink'),
      kind: 'label',
      x: Math.round(lr ? mx - tb.w / 2 : mx + 8),
      y: Math.round(lr ? my - tb.h - 4 : my - tb.h / 2),
      w: 0,
      h: 0,
      stroke: INK_SOFT,
      width: 1,
      text: e.label,
      fontSize: EDGE_SIZE,
      figureId
    })
  }
  return items
}

