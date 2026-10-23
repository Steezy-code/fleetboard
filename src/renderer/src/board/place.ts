import type { Camera, Group, InkItem, Workspace } from '@shared/types'

// Where things go on the board, in one place.
//
// Every feature used to have its own rule, and most of them were "to the right of everything": a
// team's Lead, a diagram, a batch of new consoles, each one further right than the last, so a long
// session became a strip you scroll along. Now a new tile goes as close as it can to where it belongs
// — the middle of what you are looking at, or the tile it is about — without covering anything.
//
// Tidy is the same idea applied to what is already there: the board packed into rows, keeping what
// belongs together together. Pure functions, so both can be tested without a board.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** How much of a collapsed group frame is left: its header. */
export const GROUP_HEAD_H = 48
/** Clear space kept around a new tile. */
export const GAP = 40

type Space = Pick<Workspace, 'nodes' | 'groups'> & { ink?: InkItem[] }

/** Consoles and tiles in a collapsed group: hidden on the board, so they take no room. */
export function hiddenIds(ws: Space): Set<string> {
  const collapsed = new Set(ws.groups.filter((g) => g.collapsed).map((g) => g.id))
  return new Set(ws.nodes.filter((n) => n.groupId && collapsed.has(n.groupId)).map((n) => n.id))
}

/** The box a group frame takes: all of it, or its header when collapsed. */
export const groupBox = (g: Group): Box => ({ x: g.x, y: g.y, w: g.w, h: g.collapsed ? Math.min(g.h, GROUP_HEAD_H) : g.h })

/** The top-left that would put a box of `size` in the middle of the view. */
export const viewCentre = (vp: { w: number; h: number }, cam: Camera, size: { w: number; h: number }) => ({
  x: (vp.w / 2 - cam.x) / cam.zoom - size.w / 2,
  y: (vp.h / 2 - cam.y) / cam.zoom - size.h / 2
})

/** Everything that takes room on the board. */
export function occupied(ws: Space): Box[] {
  const hidden = hiddenIds(ws)
  return [...ws.nodes.filter((n) => !hidden.has(n.id)), ...ws.groups.map(groupBox), ...(ws.ink ?? [])]
}

const overlaps = (a: Box, b: Box, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/**
 * The top-left for a box of `size`, as close to `near` (the top-left it would ideally have) as it can
 * be without coming within `gap` of anything. Candidates line up with the edges of what is there, so
 * a busy board stays in rows and columns rather than filling with near-misses.
 */
export function findFreeSpot(boxes: Box[], size: { w: number; h: number }, near: { x: number; y: number }, gap = GAP): { x: number; y: number } {
  const fits = (x: number, y: number) => !boxes.some((b) => overlaps({ x, y, ...size }, b, gap))
  const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) })
  if (fits(near.x, near.y)) return round(near)
  let best: { x: number; y: number } | null = null
  let bestD = Infinity
  for (const b of boxes) {
    for (const c of [
      { x: b.x + b.w + gap, y: b.y },
      { x: b.x, y: b.y + b.h + gap },
      { x: b.x - size.w - gap, y: b.y },
      { x: b.x, y: b.y - size.h - gap },
      { x: b.x + b.w + gap, y: near.y },
      { x: near.x, y: b.y + b.h + gap }
    ]) {
      const d = (c.x - near.x) ** 2 + (c.y - near.y) ** 2
      if (d < bestD && fits(c.x, c.y)) {
        best = c
        bestD = d
      }
    }
  }
  // right of everything is always free
  return round(best ?? { x: Math.max(...boxes.map((b) => b.x + b.w)) + gap, y: near.y })
}

// ---------------------------------------------------------------- tidy

export interface TidyUnit {
  /** every id that moves with this unit: nodes, groups, ink */
  ids: string[]
  box: Box
  /** units with consoles come first */
  consoles: boolean
}

export interface TidyMove {
  ids: string[]
  dx: number
  dy: number
}

const bbox = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

/**
 * What moves together: a group with everything in it; things joined by a wire (a Lead and its
 * workers, the orchestrator and its teams); a plan with its Lead; a diagram's strokes. Loose ink —
 * a note drawn by hand — stays where it was drawn, since it is about whatever is under it.
 */
export function tidyUnits(ws: Space & Pick<Workspace, 'wires'>): TidyUnit[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  const join = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return
    parent.set(find(a), find(b))
  }
  for (const n of ws.nodes) parent.set(n.id, n.id)
  for (const g of ws.groups) parent.set(g.id, g.id)
  const figures = new Map<string, InkItem[]>()
  for (const i of ws.ink ?? []) if (i.figureId) figures.set(i.figureId, [...(figures.get(i.figureId) ?? []), i])
  for (const n of ws.nodes) {
    if (n.groupId) join(n.id, n.groupId)
    if (n.type === 'plan' && typeof n.data?.leadId === 'string') join(n.id, n.data.leadId)
  }
  for (const w of ws.wires) join(w.from, w.to)

  const hidden = hiddenIds(ws)
  const byRoot = new Map<string, { ids: string[]; boxes: Box[]; consoles: boolean }>()
  const add = (id: string, box: Box | null, console: boolean) => {
    const r = find(id)
    const u = byRoot.get(r) ?? { ids: [], boxes: [], consoles: false }
    u.ids.push(id)
    if (box) u.boxes.push(box)
    u.consoles ||= console
    byRoot.set(r, u)
  }
  // a hidden member moves with its group but does not make the unit bigger than the header
  for (const n of ws.nodes) add(n.id, hidden.has(n.id) ? null : n, n.type === 'console')
  for (const g of ws.groups) add(g.id, groupBox(g), false)
  const units: TidyUnit[] = [...byRoot.values()].filter((u) => u.boxes.length).map((u) => ({ ids: u.ids, box: bbox(u.boxes), consoles: u.consoles }))
  for (const items of figures.values()) units.push({ ids: items.map((i) => i.id), box: bbox(items), consoles: false })
  return units
}

/**
 * Pack the units into rows from `origin`: consoles first, then everything else; within each, tallest
 * first (the usual shelf packing: rows of similar height waste the least), then in reading order. The
 * order depends only on sizes and positions, so tidying a tidy board changes nothing. Rows are a
 * little wider than a square of the same area, since screens are.
 */
export function tidyLayout(units: TidyUnit[], origin: { x: number; y: number }, gap = 60): TidyMove[] {
  if (!units.length) return []
  const order = [...units].sort((a, b) => Number(b.consoles) - Number(a.consoles) || b.box.h - a.box.h || a.box.y - b.box.y || a.box.x - b.box.x)
  const area = order.reduce((s, u) => s + (u.box.w + gap) * (u.box.h + gap), 0)
  const rowW = Math.max(...order.map((u) => u.box.w), Math.sqrt(area) * 1.6)
  const moves: TidyMove[] = []
  let x = origin.x
  let y = origin.y
  let rowH = 0
  for (const u of order) {
    if (x > origin.x && x + u.box.w > origin.x + rowW) {
      x = origin.x
      y += rowH + gap
      rowH = 0
    }
    const dx = Math.round(x - u.box.x)
    const dy = Math.round(y - u.box.y)
    if (dx || dy) moves.push({ ids: u.ids, dx, dy })
    x += u.box.w + gap
    rowH = Math.max(rowH, u.box.h)
  }
  return moves
}

/** The top-left of everything, where a tidied board starts. */
export const contentOrigin = (units: TidyUnit[]) => ({ x: Math.min(...units.map((u) => u.box.x)), y: Math.min(...units.map((u) => u.box.y)) })
