import { SCHEMA_VERSION, type Project } from './types'

export interface BoardPreview {
  token: string
  name: string
  workspaces: number
  tiles: number
  consoles: number
  notes: string[]
  contents: { name: string; tiles: number; titles: string[] }[]
}
export interface SnapshotInfo { id: string; at: number; bytes: number }

/** Imported boards are data, not instructions to start processes or scheduled work. */
export function portableBoard(value: unknown, target: Project): Project {
  const p = structuredClone(value) as Project
  const object = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!object(p) || !Number.isInteger(p.schema) || p.schema > SCHEMA_VERSION || p.schema < 1 || !Array.isArray(p.workspaces) || !p.workspaces.length || p.workspaces.length > 100) throw new Error('Unsupported or invalid board format')
  const ids = new Set<string>()
  const id = (v: unknown) => {
    if (typeof v !== 'string' || !/^[\w-]{1,160}$/.test(v) || ids.has(v)) throw new Error('Invalid or duplicate board ID')
    ids.add(v)
  }
  const box = (v: { x: number; y: number; w: number; h: number }, allowZero = false) => {
    if (![v.x, v.y, v.w, v.h].every(Number.isFinite) || (allowZero ? v.w < 0 || v.h < 0 : v.w <= 0 || v.h <= 0)) throw new Error('Invalid tile geometry')
  }
  for (const w of p.workspaces) {
    if (!object(w) || !Array.isArray(w.nodes) || w.nodes.length > 10000 || !Array.isArray(w.groups) || !Array.isArray(w.wires) || !Array.isArray(w.ink)) throw new Error('Invalid workspace')
    id(w.id)
    if (typeof w.name !== 'string' || !object(w.camera) || ![w.camera.x, w.camera.y, w.camera.zoom].every(Number.isFinite) || w.camera.zoom <= 0) throw new Error('Invalid workspace view')
    w.extras = {}
    for (const n of w.nodes) {
      if (!object(n) || typeof n.type !== 'string' || !object(n.data) || !Number.isFinite(n.z)) throw new Error('Invalid tile')
      id(n.id); box(n)
      if (n.type === 'console') {
        n.data = { ...n.data, launch: 'ask', autoApprove: false, acceptEdits: false }
        delete n.data.profileId
        delete n.data.command
        delete n.data.extraArgs
        n.data.cwd = target.path
      }
    }
    for (const g of w.groups) { if (!object(g)) throw new Error('Invalid group'); id(g.id); box(g) }
    for (const ink of w.ink) { if (!object(ink)) throw new Error('Invalid ink'); id(ink.id); box(ink, true) }
    for (const wire of w.wires) if (!object(wire) || typeof wire.from !== 'string' || typeof wire.to !== 'string') throw new Error('Invalid wire')
  }
  const extras: Project['extras'] = {}
  if (object(p.extras)) {
    if (Array.isArray(p.extras.documents)) extras.documents = p.extras.documents.filter((d: any) => object(d) && typeof d.id === 'string' && typeof d.title === 'string' && typeof d.markdown === 'string')
    if (Array.isArray(p.extras.memory)) extras.memory = p.extras.memory.filter((m: any) => object(m) && typeof m.id === 'string' && typeof m.title === 'string' && typeof m.body === 'string').map((m: any) => ({ ...m, scope: 'repo', repoPath: target.path }))
  }
  return { ...p, id: target.id, name: target.name, path: target.path, schema: SCHEMA_VERSION, lastOpened: Date.now(), activeWorkspaceId: p.workspaces.some((w) => w.id === p.activeWorkspaceId) ? p.activeWorkspaceId : p.workspaces[0].id, extras }
}
