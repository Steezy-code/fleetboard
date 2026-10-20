import { pairs } from '@shared/seq'
import type { DiagramSpec, DNode } from './spec'

// Layered DAG layout (Sugiyama-style, small graphs):
//   1. break cycles with a DFS, 2. longest-path ranking, 3. virtual nodes on long edges,
//   4. barycenter sweeps (keeping group members clustered) to reduce crossings,
//   5. coordinates: per layer, the order-preserving placement closest to the neighbors' barycenter
//      (isotonic regression / pool-adjacent-violators), inside a band per group,
//   6. edges clipped from shape border to shape border.
// Plus a radial layout for mind maps. All coordinates are relative to (0,0).

export type Pt = [number, number]

export interface LNode extends DNode {
  x: number
  y: number
  w: number
  h: number
  /** label lines followed by sub lines */
  lines: string[]
  labelLines: number
  depth?: number
}

export interface LEdge {
  from: string
  to: string
  label?: string
  points: Pt[]
  directed: boolean
  labelAt?: Pt
}

export interface LGroup {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  title: string
  dir: 'TB' | 'LR' | 'radial'
  nodes: LNode[]
  edges: LEdge[]
  groups: LGroup[]
  width: number
  height: number
}

export const CHAR_PX = 8.4
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > max) {
      if (cur) lines.push(cur), (cur = '')
      lines.push(w.slice(0, max - 1) + '-')
      w = w.slice(max - 1)
    }
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w
    else lines.push(cur), (cur = w)
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

function sizeNode(n: DNode, root = false): Pick<LNode, 'w' | 'h' | 'lines' | 'labelLines'> {
  const longest = Math.max(n.label.length, Math.min(n.sub?.length ?? 0, 34))
  let w = clamp(longest * CHAR_PX + 44, root ? 170 : 132, 252)
  const max = Math.max(8, Math.floor((w - 34) / CHAR_PX))
  const label = wrap(n.label, max).slice(0, 3)
  const sub = n.sub ? wrap(n.sub, max).slice(0, 2) : []
  let h = Math.max(root ? 72 : 60, 28 + label.length * 20 + sub.length * 18)
  if (n.shape === 'diamond') {
    w = Math.max(w * 1.5, 160)
    h = Math.max(h * 1.65, 104)
  } else if (n.shape === 'ellipse') {
    w = w * 1.16
    h = Math.max(h * 1.24, 66)
  }
  return { w: Math.round(w), h: Math.round(h), lines: [...label, ...sub], labelLines: label.length }
}

/** Point on the node's outline in the direction of `toward`, pushed out by `gap`. */
export function borderPoint(n: { x: number; y: number; w: number; h: number; shape: string }, toward: Pt, gap = 7): Pt {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  if (!dx && !dy) return [cx, cy]
  const a = n.w / 2
  const b = n.h / 2
  let t: number
  if (n.shape === 'ellipse') t = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2)
  else if (n.shape === 'diamond') t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
  else t = Math.min(dx ? a / Math.abs(dx) : Infinity, dy ? b / Math.abs(dy) : Infinity)
  const len = Math.hypot(dx, dy)
  return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap]
}

/** Point halfway along an edge's polyline. At least one point, for the reason midPoint gives. */
function polylineMid(points: [Pt, ...Pt[]]): Pt {
  const segs = [...pairs(points)].map(([a, b]) => ({ a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }))
  const half = segs.reduce((sum, sg) => sum + sg.len, 0) / 2
  let acc = 0
  for (const { a, b, len } of segs) {
    if (acc + len >= half) {
      const k = len ? (half - acc) / len : 0
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
    }
    acc += len
  }
  return points[0]
}

export function layoutDiagram(spec: DiagramSpec): Layout {
  return spec.layout === 'radial' ? radial(spec) : layered(spec, spec.layout === 'LR' ? 'LR' : 'TB')
}

// ---------------------------------------------------------------- layered

interface V {
  id: string
  rank: number
  /** size across the layer (x in TB) and along the ranks (y in TB) */
  cross: number
  main: number
  dummy: boolean
  key: string
}

/** Order-preserving placement closest to `desired` with minimum center separations (PAV). */
function placeOrdered(desired: number[], seps: number[]): number[] {
  // each wanted position with the running separation it sits behind, so the two cannot come apart
  let run = 0
  const items = desired.map((want, i) => {
    run = i ? run + (seps[i] ?? 0) : 0
    return { want, offset: run }
  })
  const blocks: { v: number; w: number; n: number }[] = []
  for (const { want, offset } of items) {
    blocks.push({ v: want - offset, w: 1, n: 1 })
    // merge back while the block before this one wants to be further along than it does
    for (;;) {
      const b = blocks[blocks.length - 1]
      const a = blocks[blocks.length - 2]
      if (!a || !b || a.v <= b.v) break
      blocks.pop()
      a.v = (a.v * a.w + b.v * b.w) / (a.w + b.w)
      a.w += b.w
      a.n += b.n
    }
  }
  const out: number[] = []
  // the blocks cover the items exactly, so each position has its own offset back
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v + (items[out.length]?.offset ?? 0))
  return out
}

function layered(spec: DiagramSpec, dir: 'TB' | 'LR'): Layout {
  const nodes = spec.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sizes = new Map(nodes.map((n) => [n.id, sizeNode(n)]))
  const hasGroups = (spec.groups?.length ?? 0) > 0
  const hasLabels = spec.edges.some((e) => e.label)

  // 1. break cycles
  const out = new Map<string, { to: string; i: number }[]>(nodes.map((n) => [n.id, []]))
  spec.edges.forEach((e, i) => out.get(e.from)!.push({ to: e.to, i }))
  const reversed = new Set<number>()
  const state = new Map<string, number>()
  const dfs = (v: string) => {
    state.set(v, 1)
    for (const { to, i } of out.get(v)!) {
      const s = state.get(to) ?? 0
      if (s === 1) reversed.add(i)
      else if (s === 0) dfs(to)
    }
    state.set(v, 2)
  }
  nodes.forEach((n) => !state.get(n.id) && dfs(n.id))
  const dag = spec.edges.map((e, i) => (reversed.has(i) ? { a: e.to, b: e.from, i } : { a: e.from, b: e.to, i }))

  // 2. longest-path ranking
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const { a, b } of dag) {
    succs.get(a)!.push(b)
    preds.get(b)!.push(a)
  }
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id)!.length]))
  const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id)
  const topo: string[] = []
  while (queue.length) {
    const v = queue.shift()!
    topo.push(v)
    for (const s of succs.get(v)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (!indeg.get(s)) queue.push(s)
    }
  }
  const rank = new Map<string, number>()
  for (const v of topo) rank.set(v, Math.max(0, ...preds.get(v)!.map((p) => rank.get(p)! + 1)))
  // pull sources down next to their first successor so they do not float at the top
  for (const v of [...topo].reverse()) {
    if (preds.get(v)!.length || !succs.get(v)!.length) continue
    rank.set(v, Math.min(...succs.get(v)!.map((s) => rank.get(s)!)) - 1)
  }
  const minRank = Math.min(...[...rank.values()])
  rank.forEach((r, k) => rank.set(k, r - minRank))

  // 3. virtual nodes
  const crossOf = (id: string) => (dir === 'TB' ? sizes.get(id)!.w : sizes.get(id)!.h)
  const mainOf = (id: string) => (dir === 'TB' ? sizes.get(id)!.h : sizes.get(id)!.w)
  const V = new Map<string, V>()
  for (const n of nodes) V.set(n.id, { id: n.id, rank: rank.get(n.id)!, cross: crossOf(n.id), main: mainOf(n.id), dummy: false, key: n.group ?? '' })
  const chains: string[][] = []
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    if (!down.has(a)) down.set(a, [])
    if (!up.has(b)) up.set(b, [])
    down.get(a)!.push(b)
    up.get(b)!.push(a)
  }
  let dn = 0
  for (const { a, b, i } of dag) {
    const chain = [a]
    const ga = byId.get(a)!.group ?? ''
    const gb = byId.get(b)!.group ?? ''
    for (let r = rank.get(a)! + 1; r < rank.get(b)!; r++) {
      const id = `~${dn++}`
      V.set(id, { id, rank: r, cross: 16, main: 0, dummy: true, key: ga === gb ? ga : '' })
      chain.push(id)
    }
    chain.push(b)
    for (const [from, to] of pairs(chain)) link(from, to)
    chains[i] = chain
  }

  const R = Math.max(...[...V.values()].map((v) => v.rank)) + 1
  let layers: string[][] = Array.from({ length: R }, () => [])
  for (const v of V.values()) (layers[v.rank] ??= []).push(v.id)
  /** the ids at a rank — nothing at a rank outside the graph, which is what an empty layer is */
  const layer = (r: number): string[] => layers[r] ?? []

  // 4. ordering
  const pos = new Map<string, number>()
  const index = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)))
  index()
  const groupOrder = () => {
    const acc = new Map<string, { s: number; n: number }>()
    for (const l of layers)
      l.forEach((id, i) => {
        const k = V.get(id)!.key
        const a = acc.get(k) ?? { s: 0, n: 0 }
        a.s += l.length > 1 ? i / (l.length - 1) : 0.5
        a.n++
        acc.set(k, a)
      })
    const keys = [...acc.entries()].sort((x, y) => x[1].s / x[1].n - y[1].s / y[1].n).map(([k]) => k)
    return new Map(keys.map((k, i) => [k, i]))
  }
  const cluster = () => {
    const go = groupOrder()
    layers = layers.map((l) => [...l].sort((a, b) => go.get(V.get(a)!.key)! - go.get(V.get(b)!.key)! || pos.get(a)! - pos.get(b)!))
    index()
  }
  const crossings = () => {
    let c = 0
    for (let r = 0; r + 1 < R; r++) {
      const es: [number, number][] = []
      for (const a of layer(r)) for (const b of down.get(a) ?? []) es.push([pos.get(a)!, pos.get(b)!])
      // every pair of edges between these two ranks: they cross when their ends are in opposite order
      for (const [i, e1] of es.entries()) for (const e2 of es.slice(i + 1)) if ((e1[0] - e2[0]) * (e1[1] - e2[1]) < 0) c++
    }
    return c
  }
  const sortLayer = (r: number, nb: Map<string, string[]>) => {
    const bary = new Map<string, number>()
    for (const id of layer(r)) {
      const ns = nb.get(id) ?? []
      bary.set(id, ns.length ? ns.reduce((s, u) => s + pos.get(u)!, 0) / ns.length : pos.get(id)!)
    }
    const sorted = [...layer(r)].sort((a, b) => bary.get(a)! - bary.get(b)!)
    layers[r] = sorted
    sorted.forEach((id, i) => pos.set(id, i))
  }
  if (hasGroups) cluster()
  let best = layers.map((l) => [...l])
  let bestC = crossings()
  for (let it = 0; it < 14 && bestC > 0; it++) {
    if (it % 2 === 0) for (let r = 1; r < R; r++) sortLayer(r, up)
    else for (let r = R - 2; r >= 0; r--) sortLayer(r, down)
    if (hasGroups) cluster()
    const c = crossings()
    if (c < bestC) {
      bestC = c
      best = layers.map((l) => [...l])
    }
  }
  layers = best
  index()

  // 5. coordinates
  const rankGap = dir === 'TB' ? (hasLabels ? 92 : 70) : hasLabels ? 120 : 88
  const nodeGap = dir === 'TB' ? 46 : 34
  const padLo = dir === 'TB' ? 26 : 42
  const padHi = 26
  const thickness = layers.map((l) => Math.max(0, ...l.map((id) => V.get(id)!.main)))
  // each rank half its own thickness past the gap after the one before it
  const mainAt: number[] = []
  let prevAt = 0
  let prevThick = 0
  for (const [r, t] of thickness.entries()) {
    prevAt = r ? prevAt + prevThick / 2 + rankGap + t / 2 : t / 2
    prevThick = t
    mainAt.push(prevAt)
  }

  const sep = (a: string, b: string) => {
    const va = V.get(a)!
    const vb = V.get(b)!
    const g = va.dummy || vb.dummy ? 20 : nodeGap
    return (va.cross + vb.cross) / 2 + g
  }
  // segments: runs of the same cluster key inside a layer, each bound to its band
  const go = groupOrder()
  const keys = [...go.keys()].sort((a, b) => go.get(a)! - go.get(b)!)
  const bands = new Map<string, { lo: number; hi: number }>()
  if (hasGroups) {
    let at = 0
    for (const k of keys) {
      let width = 0
      for (const l of layers) {
        const m = l.filter((id) => V.get(id)!.key === k)
        const [firstInBand] = m
        if (!firstInBand) continue
        let w = V.get(firstInBand)!.cross
        for (const [prev, id] of pairs(m)) w += sep(prev, id) - (V.get(prev)!.cross + V.get(id)!.cross) / 2 + V.get(id)!.cross
        width = Math.max(width, w)
      }
      const lo = at + (k ? padLo : 0)
      bands.set(k, { lo, hi: lo + width })
      at = lo + width + (k ? padHi : 0) + 64
    }
  }
  const segments = (l: string[]) => {
    const segs: string[][] = []
    for (const id of l) {
      const k = V.get(id)!.key
      const last = segs[segs.length - 1]
      const head = last?.[0]
      if (hasGroups && last && head && V.get(head)!.key === k) last.push(id)
      else if (!hasGroups && last) last.push(id)
      else segs.push([id])
    }
    return segs
  }
  const x = new Map<string, number>()
  const place = (seg: string[], desired: number[]) => {
    const first = seg[0]
    const last = seg[seg.length - 1]
    if (!first || !last) return
    const seps = seg.map((id, i) => {
      const prev = seg[i - 1]
      return prev ? sep(prev, id) : 0
    })
    let xs = placeOrdered(desired, seps)
    const band = hasGroups ? bands.get(V.get(first)!.key) : undefined
    if (band) {
      const left = (xs[0] ?? 0) - V.get(first)!.cross / 2
      const right = (xs[xs.length - 1] ?? 0) + V.get(last)!.cross / 2
      let shift = 0
      if (right - left >= band.hi - band.lo) shift = (band.lo + band.hi) / 2 - (left + right) / 2
      else if (left < band.lo) shift = band.lo - left
      else if (right > band.hi) shift = band.hi - right
      xs = xs.map((v) => v + shift)
    }
    // one position per id, so a node without one keeps where it was rather than moving to zero
    seg.forEach((id, i) => {
      const at = xs[i]
      if (at !== undefined) x.set(id, at)
    })
  }
  // initial: packed and centered (in its band)
  for (const l of layers)
    for (const seg of segments(l)) {
      const head = seg[0]
      const band = hasGroups && head ? bands.get(V.get(head)!.key) : undefined
      const center = band ? (band.lo + band.hi) / 2 : 0
      place(seg, seg.map(() => center))
    }
  const mean = (ids: string[]) => ids.reduce((s, u) => s + x.get(u)!, 0) / ids.length
  for (let it = 0; it < 12; it++) {
    const order = it % 2 === 0 ? layers.map((_, r) => r) : layers.map((_, r) => R - 1 - r)
    for (const r of order) {
      for (const seg of segments(layer(r))) {
        const desired = seg.map((id) => {
          const ns = it >= 10 ? [...(up.get(id) ?? []), ...(down.get(id) ?? [])] : it % 2 === 0 ? up.get(id) ?? [] : down.get(id) ?? []
          return ns.length ? mean(ns) : x.get(id)!
        })
        place(seg, desired)
      }
    }
  }

  // map to x/y
  const center = (id: string): Pt => {
    const v = V.get(id)!
    const along = mainAt[v.rank] ?? 0
    return dir === 'TB' ? [x.get(id)!, along] : [along, x.get(id)!]
  }
  const lnodes: LNode[] = nodes.map((n) => {
    const s = sizes.get(n.id)!
    const [cx, cy] = center(n.id)
    return { ...n, ...s, x: cx - s.w / 2, y: cy - s.h / 2 }
  })
  const lmap = new Map(lnodes.map((n) => [n.id, n]))

  // 6. edges
  const edges: LEdge[] = spec.edges.flatMap((e, i) => {
    // a chain is [from, …one dummy per rank crossed, to], one per edge and never shorter than two,
    // since spec.ts drops an edge whose ends are the same node
    const chain = chains[i]
    if (!chain) return []
    const pts = (reversed.has(i) ? [...chain].reverse() : chain).map(center)
    const second = pts[1]
    if (!second) return []
    const a = lmap.get(e.from)!
    const b = lmap.get(e.to)!
    // each end stops at its node's border, aiming at the next point along — which for a two-point
    // edge means the far end aims at the near end as it has just been moved
    const start = borderPoint(a, second)
    const toward = pts.length > 2 ? pts[pts.length - 2] ?? start : start
    const points: [Pt, ...Pt[]] = [start, ...pts.slice(1, -1), borderPoint(b, toward)]
    return [{ from: e.from, to: e.to, label: e.label, points, directed: true, labelAt: polylineMid(points) }]
  })

  const groups: LGroup[] = (spec.groups ?? []).flatMap((g) => {
    const m = lnodes.filter((n) => n.group === g.id)
    if (!m.length) return []
    const l = Math.min(...m.map((n) => n.x)) - 26
    const t = Math.min(...m.map((n) => n.y)) - 42
    const r = Math.max(...m.map((n) => n.x + n.w)) + 26
    const b = Math.max(...m.map((n) => n.y + n.h)) + 24
    return [{ id: g.id, label: g.label, x: l, y: t, w: r - l, h: b - t }]
  })

  return normalize({ title: spec.title, dir, nodes: lnodes, edges, groups, width: 0, height: 0 })
}

// ---------------------------------------------------------------- radial (mind map)

function radial(spec: DiagramSpec): Layout {
  const nodes = spec.nodes
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]))
  for (const e of spec.edges) {
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }
  // root: a node nothing points to (the most connected one), else the most connected overall
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of spec.edges) indeg.set(e.to, indeg.get(e.to)! + 1)
  // a spec always holds at least one node (sanitizeSpec returns null otherwise), so there is a root
  const byDegree: [DNode, ...DNode[]] = [...nodes]
  byDegree.sort((a, b) => adj.get(b.id)!.size - adj.get(a.id)!.size)
  const root = byDegree.find((n) => !indeg.get(n.id) && adj.get(n.id)!.size) ?? byDegree[0]
  const parent = new Map<string, string | null>([[root.id, null]])
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  const depth = new Map<string, number>([[root.id, 0]])
  const queue = [root.id]
  while (queue.length) {
    const v = queue.shift()!
    for (const u of adj.get(v)!)
      if (!parent.has(u)) {
        parent.set(u, v)
        depth.set(u, depth.get(v)! + 1)
        children.get(v)!.push(u)
        queue.push(u)
      }
  }
  const extra: { from: string; to: string }[] = []
  for (const n of nodes)
    if (!parent.has(n.id)) {
      parent.set(n.id, root.id)
      depth.set(n.id, 1)
      children.get(root.id)!.push(n.id)
      extra.push({ from: root.id, to: n.id })
    }
  const sizes = new Map(nodes.map((n) => [n.id, sizeNode(n, n.id === root.id)]))
  const leaves = new Map<string, number>()
  const count = (v: string): number => {
    const c = children.get(v)!
    const n = c.length ? c.reduce((s, u) => s + count(u), 0) : 1
    leaves.set(v, n)
    return n
  }
  count(root.id)

  const ring1 = children.get(root.id)!
  const circ1 = ring1.reduce((s, id) => s + Math.max(sizes.get(id)!.w, sizes.get(id)!.h) + 50, 0)
  const r1 = Math.max(250, circ1 / (2 * Math.PI))
  const radius = (d: number) => (d === 0 ? 0 : r1 + (d - 1) * 230)
  const pos = new Map<string, Pt>()
  const assign = (v: string, a0: number, a1: number) => {
    const d = depth.get(v)!
    const a = (a0 + a1) / 2
    pos.set(v, [Math.cos(a) * radius(d), Math.sin(a) * radius(d)])
    const total = leaves.get(v)!
    let at = a0
    for (const c of children.get(v)!) {
      const span = ((a1 - a0) * leaves.get(c)!) / total
      assign(c, at, at + span)
      at += span
    }
  }
  assign(root.id, -Math.PI / 2, (3 * Math.PI) / 2)
  pos.set(root.id, [0, 0])

  const lnodes: LNode[] = nodes.map((n) => {
    const s = sizes.get(n.id)!
    const [cx, cy] = pos.get(n.id)!
    return { ...n, ...s, shape: n.id === root.id && n.shape === 'rect' ? 'ellipse' : n.shape, x: cx - s.w / 2, y: cy - s.h / 2, depth: depth.get(n.id) }
  })
  // root drawn as an ellipse: give it the ellipse proportions
  const r = lnodes.find((n) => n.id === root.id)!
  if (r.shape === 'ellipse' && root.shape === 'rect') {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    r.w = Math.round(r.w * 1.16)
    r.h = Math.round(Math.max(r.h * 1.24, 74))
    r.x = cx - r.w / 2
    r.y = cy - r.h / 2
  }
  const lmap = new Map(lnodes.map((n) => [n.id, n]))
  const edges: LEdge[] = [...spec.edges, ...extra].map((e) => {
    const a = lmap.get(e.from)!
    const b = lmap.get(e.to)!
    const ca: Pt = [a.x + a.w / 2, a.y + a.h / 2]
    const cb: Pt = [b.x + b.w / 2, b.y + b.h / 2]
    const pts: [Pt, Pt] = [borderPoint(a, cb, 4), borderPoint(b, ca, 4)]
    return { from: e.from, to: e.to, label: (e as any).label, points: pts, directed: false, labelAt: polylineMid(pts) }
  })
  return normalize({ title: spec.title, dir: 'radial', nodes: lnodes, edges, groups: [], width: 0, height: 0 })
}

/** Shift everything so the content starts at (0,0) and record its size. */
function normalize(l: Layout): Layout {
  const xs: number[] = []
  const ys: number[] = []
  for (const n of [...l.nodes, ...l.groups]) xs.push(n.x, n.x + n.w), ys.push(n.y, n.y + n.h)
  for (const e of l.edges) for (const p of e.points) xs.push(p[0]), ys.push(p[1])
  const ox = Math.min(...xs)
  const oy = Math.min(...ys)
  const sh = (p: Pt): Pt => [p[0] - ox, p[1] - oy]
  return {
    ...l,
    nodes: l.nodes.map((n) => ({ ...n, x: n.x - ox, y: n.y - oy })),
    groups: l.groups.map((g) => ({ ...g, x: g.x - ox, y: g.y - oy })),
    edges: l.edges.map((e) => ({ ...e, points: e.points.map(sh), labelAt: e.labelAt && sh(e.labelAt) })),
    width: Math.max(...xs) - ox,
    height: Math.max(...ys) - oy
  }
}
