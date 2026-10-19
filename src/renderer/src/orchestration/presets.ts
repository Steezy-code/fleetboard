import type { BoardNode, NodeType, Role } from '@shared/types'
import { invoke, uid } from '../lib/api'
import { activeWs, useApp } from '../state/store'
import { CONSOLE_H, CONSOLE_W, spawnConsoles } from '../engine/consoles'
import { NODE_DEFS } from '../nodes/registry'

// Board presets: lay out consoles, teams, tiles and wires in one tap. Built-ins are recipes;
// saved presets are relative snapshots of a workspace layout (no live processes).

/** Schematic for the card preview, in a 100×60 box. */
export interface SchemaRect {
  x: number
  y: number
  w: number
  h: number
  kind: 'console' | 'team' | 'tile' | 'orch'
  color?: string
}

export interface PresetDef {
  id: string
  name: string
  blurb: string
  /** agents it wants (shown as dots), resolved to installed ones */
  agents: string[]
  schema: SchemaRect[]
  wires?: [number, number][]
  apply: (pick: (want: string) => string) => void
}

const GAP = 24
const TEAM_PAD = 24
const TEAM_HEAD = 58
const teamW = (cols: number) => TEAM_PAD * 2 + cols * CONSOLE_W + (cols - 1) * GAP
const teamH = (rows: number) => TEAM_HEAD + rows * CONSOLE_H + (rows - 1) * GAP + TEAM_PAD

/** Free origin right of everything on the active board (or around the view center). */
export function presetOrigin(): { x: number; y: number } {
  const ws = activeWs()
  const boxes = ws ? [...ws.nodes, ...ws.groups] : []
  if (!ws || !boxes.length) {
    const vp = useApp.getState().viewport
    const cam = ws?.camera ?? { x: 0, y: 0, zoom: 1 }
    return { x: Math.round((vp.w / 2 - cam.x) / cam.zoom - 600), y: Math.round((vp.h / 2 - cam.y) / cam.zoom - 300) }
  }
  return { x: Math.max(...boxes.map((b) => b.x + b.w)) + 160, y: Math.min(...boxes.map((b) => b.y)) }
}

const groupOf = (nodeId: string) => activeWs()?.nodes.find((n) => n.id === nodeId)?.groupId

function team(agents: string[], name: string, role: Role, at: { x: number; y: number }, cols = 2): string | undefined {
  const ids = spawnConsoles({ agents, group: { name, role }, at, cols })
  return ids[0] ? groupOf(ids[0]) : undefined
}

function tile(type: NodeType, x: number, y: number, data: Record<string, any> = {}, size?: { w: number; h: number }): string {
  const def = NODE_DEFS[type]
  const s = size ?? def?.defaultSize ?? { w: 480, h: 320 }
  return useApp.getState().addNode({ type, x, y, w: s.w, h: s.h, data: { ...(def?.create?.() ?? {}), ...data } })
}

const C = (x: number, y: number, w = 22, h = 14, color?: string): SchemaRect => ({ x, y, w, h, kind: 'console', color })
const T = (x: number, y: number, w: number, h: number): SchemaRect => ({ x, y, w, h, kind: 'team' })
const Tl = (x: number, y: number, w: number, h: number): SchemaRect => ({ x, y, w, h, kind: 'tile' })

export const BUILTIN_PRESETS: PresetDef[] = [
  {
    id: 'pair',
    name: 'Pair',
    blurb: 'Two Claude consoles side by side.',
    agents: ['claude', 'claude'],
    schema: [C(14, 18, 34, 24), C(52, 18, 34, 24)],
    apply: (pick) => spawnConsoles({ agents: [pick('claude'), pick('claude')], cols: 2, at: presetOrigin() })
  },
  {
    id: 'trio',
    name: 'Trio',
    blurb: 'Claude, Codex and Gemini on the same task.',
    agents: ['claude', 'codex', 'gemini'],
    schema: [C(6, 20, 27, 20, '#d97757'), C(36.5, 20, 27, 20, '#6b7cff'), C(67, 20, 27, 20, '#4f8df7')],
    apply: (pick) => spawnConsoles({ agents: [pick('claude'), pick('codex'), pick('gemini')], cols: 3, at: presetOrigin() })
  },
  {
    id: 'squad',
    name: 'Squad',
    blurb: 'Four Claude consoles in one team.',
    agents: ['claude', 'claude', 'claude', 'claude'],
    schema: [T(18, 6, 64, 48), C(24, 14, 25, 17), C(51, 14, 25, 17), C(24, 33, 25, 17), C(51, 33, 25, 17)],
    apply: (pick) => team([1, 2, 3, 4].map(() => pick('claude')), 'Squad', 'General', presetOrigin())
  },
  {
    id: 'review',
    name: 'Review squad',
    blurb: 'A Claude builder and a team of two reviewers.',
    agents: ['claude', 'claude', 'codex'],
    schema: [C(6, 20, 26, 20), T(40, 10, 56, 40), C(45, 20, 22, 20), C(70, 20, 22, 20, '#6b7cff')],
    wires: [[0, 1]],
    apply: (pick) => {
      const o = presetOrigin()
      const [builder] = spawnConsoles({ agents: [pick('claude')], at: o })
      const g = team([pick('claude'), pick('codex')], 'Reviewers', 'Reviewers', { x: o.x + CONSOLE_W + 140, y: o.y - TEAM_HEAD + 24 })
      if (builder && g) useApp.getState().addWire(builder, g)
    }
  },
  {
    id: 'fe-be',
    name: 'Frontend + Backend',
    blurb: 'Two teams of two, split by layer.',
    agents: ['claude', 'claude', 'claude', 'claude'],
    schema: [T(4, 12, 44, 36), C(8, 22, 17, 20), C(27, 22, 17, 20), T(52, 12, 44, 36), C(56, 22, 17, 20), C(75, 22, 17, 20)],
    apply: (pick) => {
      const o = presetOrigin()
      team([pick('claude'), pick('claude')], 'Frontend', 'Frontend', o)
      team([pick('claude'), pick('claude')], 'Backend', 'Backend', { x: o.x + teamW(2) + 80, y: o.y })
    }
  },
  {
    id: 'crew',
    name: 'Full stack crew',
    blurb: 'Frontend, Backend and Testers teams, one orchestrator wired to all three.',
    agents: ['claude', 'claude', 'codex', 'claude', 'gemini'],
    schema: [
      { x: 4, y: 22, w: 18, h: 16, kind: 'orch' },
      T(36, 2, 60, 17),
      T(36, 21.5, 60, 17),
      T(36, 41, 60, 17),
      C(40, 5, 25, 11),
      C(67, 5, 25, 11),
      C(40, 24.5, 25, 11),
      C(67, 24.5, 25, 11, '#6b7cff'),
      C(40, 44, 25, 11, '#4f8df7')
    ],
    wires: [
      [0, 1],
      [0, 2],
      [0, 3]
    ],
    apply: (pick) => {
      const o = presetOrigin()
      const x = o.x + 340 + 200
      const rowH = teamH(1) + 60
      const groups = [
        team([pick('claude'), pick('claude')], 'Frontend', 'Frontend', { x, y: o.y }),
        team([pick('claude'), pick('codex')], 'Backend', 'Backend', { x, y: o.y + rowH }),
        team([pick('gemini')], 'Testers', 'Testers', { x, y: o.y + rowH * 2 }, 1)
      ]
      const orch = tile('orchestrator', o.x, o.y + rowH - 20, {}, { w: 340, h: 460 })
      for (const g of groups) if (g) useApp.getState().addWire(orch, g)
    }
  },
  {
    id: 'planning',
    name: 'Planning wall',
    blurb: 'Kanban, checklist, calendar and notes. No consoles.',
    agents: [],
    schema: [Tl(4, 6, 56, 26), Tl(64, 6, 32, 26), Tl(4, 36, 40, 20), { ...Tl(48, 36, 18, 18), color: '#d4a72c' }, { ...Tl(70, 36, 18, 18), color: '#8fb573' }],
    apply: () => {
      const o = presetOrigin()
      tile('kanban', o.x, o.y)
      tile('checklist', o.x + 860 + 40, o.y, { items: [] })
      tile('calendar', o.x, o.y + 420 + 40)
      tile('note', o.x + 620 + 40, o.y + 460, { text: 'Goals for this week', color: '#d4a72c' })
      tile('note', o.x + 620 + 40 + 240, o.y + 460, { text: 'Open questions', color: '#8fb573' })
    }
  },
  {
    id: 'webdev',
    name: 'Web dev',
    blurb: 'Claude, a live web tile on localhost:3000 and the git card.',
    agents: ['claude'],
    schema: [C(4, 10, 36, 40), Tl(44, 10, 34, 40), { ...Tl(82, 10, 14, 40), color: '#3ecf8e' }],
    apply: (pick) => {
      const o = presetOrigin()
      spawnConsoles({ agents: [pick('claude')], at: o, cols: 1 })
      tile('web', o.x + 24 + CONSOLE_W + 40, o.y, { url: 'http://localhost:3000' })
      tile('git', o.x + 24 + CONSOLE_W + 40 + 720 + 40, o.y)
    }
  }
]

// ---------------- saved presets ----------------

export interface SavedPreset {
  id: string
  name: string
  createdAt: number
  groups: { key: string; name: string; role: Role; x: number; y: number; w: number; h: number }[]
  nodes: { key: string; type: NodeType; x: number; y: number; w: number; h: number; title?: string; group?: string; data: Record<string, any> }[]
  wires: [string, string][]
}

export const loadSavedPresets = async () => ((await invoke<SavedPreset[] | null>('store:getGlobal', 'presets')) ?? []) as SavedPreset[]
export const storeSavedPresets = (list: SavedPreset[]) => invoke('store:setGlobal', 'presets', list)

/** Snapshot the active workspace layout, relative to its top-left, without live processes. */
export function snapshotLayout(name: string): SavedPreset | null {
  const ws = activeWs()
  if (!ws || (!ws.nodes.length && !ws.groups.length)) return null
  const boxes = [...ws.nodes, ...ws.groups]
  const ox = Math.min(...boxes.map((b) => b.x))
  const oy = Math.min(...boxes.map((b) => b.y))
  const keep = (n: BoardNode) => {
    if (n.type !== 'console') return JSON.parse(JSON.stringify(n.data ?? {}))
    const d = n.data
    return { agentId: d.agentId, autoApprove: d.autoApprove, profileId: d.profileId, extraArgs: d.extraArgs, command: d.command }
  }
  const ids = new Set([...ws.nodes.map((n) => n.id), ...ws.groups.map((g) => g.id)])
  return {
    id: uid('pre'),
    name,
    createdAt: Date.now(),
    groups: ws.groups.map((g) => ({ key: g.id, name: g.name, role: g.role, x: g.x - ox, y: g.y - oy, w: g.w, h: g.h })),
    nodes: ws.nodes.map((n) => ({ key: n.id, type: n.type, x: n.x - ox, y: n.y - oy, w: n.w, h: n.h, title: n.title, group: n.groupId, data: keep(n) })),
    wires: ws.wires.filter((w) => ids.has(w.from) && ids.has(w.to)).map((w) => [w.from, w.to])
  }
}

/** Lay a saved preset onto the active workspace. Consoles get fresh names and start fresh. */
export function applySaved(p: SavedPreset, pick: (want: string) => string) {
  const app = useApp.getState()
  const o = presetOrigin()
  const map = new Map<string, string>()
  for (const g of p.groups) map.set(g.key, app.addGroup({ name: g.name, role: g.role, x: o.x + g.x, y: o.y + g.y, w: g.w, h: g.h }))
  for (const n of p.nodes) {
    const groupId = n.group ? map.get(n.group) : undefined
    if (n.type === 'console') {
      const [id] = spawnConsoles({
        agentId: pick(n.data.agentId ?? 'claude'),
        autoApprove: n.data.autoApprove,
        profileId: n.data.profileId,
        group: groupId,
        // spawnConsoles adds its own padding (and header offset inside a team)
        at: { x: o.x + n.x - 24, y: o.y + n.y - (groupId ? 58 : 0) }
      })
      if (id) {
        map.set(n.key, id)
        if (n.w !== CONSOLE_W || n.h !== CONSOLE_H) app.updateNode(id, { w: n.w, h: n.h })
        if (n.data.extraArgs || n.data.command) app.updateNodeData(id, { extraArgs: n.data.extraArgs, command: n.data.command })
      }
    } else {
      map.set(n.key, app.addNode({ type: n.type, x: o.x + n.x, y: o.y + n.y, w: n.w, h: n.h, title: n.title, groupId, data: n.data }))
    }
  }
  for (const g of p.groups) {
    const id = map.get(g.key)
    if (id) useApp.getState().fitGroup(id)
  }
  for (const [a, b] of p.wires) {
    const from = map.get(a)
    const to = map.get(b)
    if (from && to) useApp.getState().addWire(from, to)
  }
}

/** Schematic for a saved preset, scaled into the 100×60 preview box. */
export function savedSchema(p: SavedPreset): SchemaRect[] {
  const items = [...p.groups.map((g) => ({ ...g, kind: 'team' as const })), ...p.nodes.map((n) => ({ ...n, kind: n.type === 'console' ? ('console' as const) : n.type === 'orchestrator' ? ('orch' as const) : ('tile' as const) }))]
  if (!items.length) return []
  const r = Math.max(...items.map((i) => i.x + i.w))
  const b = Math.max(...items.map((i) => i.y + i.h))
  const k = Math.min(92 / (r || 1), 52 / (b || 1))
  const ox = (100 - r * k) / 2
  const oy = (60 - b * k) / 2
  return items.map((i) => ({ x: ox + i.x * k, y: oy + i.y * k, w: Math.max(2, i.w * k), h: Math.max(2, i.h * k), kind: i.kind }))
}
