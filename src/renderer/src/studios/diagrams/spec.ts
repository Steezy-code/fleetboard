// The diagram description the CLI returns (and the starter templates use).

export type DShape = 'rect' | 'ellipse' | 'diamond'

export interface DNode {
  id: string
  label: string
  sub?: string
  shape: DShape
  group?: string
}

export interface DEdge {
  from: string
  to: string
  label?: string
}

export interface DGroup {
  id: string
  label: string
}

export interface DiagramSpec {
  title: string
  nodes: DNode[]
  edges: DEdge[]
  groups?: DGroup[]
  /** TB: layered top→bottom (default), LR: layered left→right, radial: mind map */
  layout?: 'TB' | 'LR' | 'radial'
}

const str = (v: unknown, max = 80) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Validate and tidy whatever JSON came back. Returns null when there is nothing drawable. */
export function sanitizeSpec(raw: any): DiagramSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const src = Array.isArray(raw) ? { nodes: raw } : raw.diagram && typeof raw.diagram === 'object' ? raw.diagram : raw
  const groups: DGroup[] = []
  const groupIds = new Set<string>()
  for (const g of Array.isArray(src.groups) ? src.groups : []) {
    const id = str(g?.id ?? g?.label, 60)
    if (!id || groupIds.has(id)) continue
    groupIds.add(id)
    groups.push({ id, label: str(g?.label ?? g?.id, 40) || id })
  }
  const nodes: DNode[] = []
  const ids = new Set<string>()
  for (const n of Array.isArray(src.nodes) ? src.nodes : []) {
    const id = str(n?.id ?? n?.label, 60)
    if (!id || ids.has(id)) continue
    ids.add(id)
    const shape: DShape = n?.shape === 'ellipse' || n?.shape === 'diamond' ? n.shape : 'rect'
    let group = str(n?.group, 60) || undefined
    if (group && !groupIds.has(group)) {
      // tolerate groups referenced by label or only declared on nodes
      const byLabel = groups.find((g) => g.label === group)
      if (byLabel) group = byLabel.id
      else {
        groupIds.add(group)
        groups.push({ id: group, label: group })
      }
    }
    nodes.push({ id, label: str(n?.label, 60) || id, sub: str(n?.sub ?? n?.detail, 70) || undefined, shape, group })
    if (nodes.length >= 40) break
  }
  if (!nodes.length) return null
  const edges: DEdge[] = []
  const seen = new Set<string>()
  for (const e of Array.isArray(src.edges) ? src.edges : Array.isArray(src.links) ? src.links : []) {
    const from = str(e?.from ?? e?.source, 60)
    const to = str(e?.to ?? e?.target, 60)
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const k = `${from}→${to}`
    if (seen.has(k)) continue
    seen.add(k)
    edges.push({ from, to, label: str(e?.label, 32) || undefined })
  }
  const used = new Set(nodes.map((n) => n.group).filter(Boolean))
  return {
    title: str(src.title, 80) || 'Diagram',
    nodes,
    edges,
    groups: groups.filter((g) => used.has(g.id)),
    layout: src.layout === 'LR' || src.layout === 'radial' ? src.layout : undefined
  }
}
