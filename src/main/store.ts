import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Project, ProjectMeta, Recovery, Settings, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@shared/types'
import type { MainContext } from './context'
import { dirs, writeJsonAtomic } from './paths'

// State lives on disk as versioned JSON: ~/.fleetboard/app.json (settings, project index, global
// values) and one file per project. Every few minutes a snapshot goes to history/. A file that
// can't be read is never overwritten: it is set aside as *.corrupt-<time>.json and the newest
// readable snapshot is used instead, and the renderer is told (store:recovered).

interface AppFile {
  schema: number
  settings: Settings
  projects: ProjectMeta[]
  global: Record<string, unknown>
}

const recoveries: Recovery[] = []
let emit: MainContext['emit'] | null = null
function recovered(r: Recovery) {
  recoveries.push(r)
  emit?.('store:recovered', r)
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const validApp = (v: unknown): v is AppFile => isObj(v) && (v.settings === undefined || isObj(v.settings)) && (v.projects === undefined || Array.isArray(v.projects))
export const validProject = (v: unknown): v is Project =>
  isObj(v) &&
  typeof v.id === 'string' &&
  Array.isArray(v.workspaces) &&
  v.workspaces.length > 0 &&
  v.workspaces.every((w: unknown) => isObj(w) && typeof w.id === 'string' && Array.isArray(w.nodes))

type Read<T> = { ok: true; value: T } | { ok: false; missing: boolean }
function readValid<T>(file: string, valid: (v: unknown) => v is T): Read<T> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ok: false, missing: true }
  }
  try {
    const v = JSON.parse(text)
    if (valid(v)) return { ok: true, value: v }
  } catch {
    /* unreadable */
  }
  return { ok: false, missing: false }
}

/** Move an unreadable file out of the way (it may still be rescued by hand). */
function setAside(file: string) {
  const copy = file.replace(/\.json$/, '') + `.corrupt-${Date.now()}.json`
  try {
    fs.renameSync(file, copy)
  } catch {
    /* gone meanwhile */
  }
  return copy
}

/** Snapshots of `prefix` in history/, newest first. */
const snapshots = (prefix: string) =>
  fs
    .readdirSync(dirs.history)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.json'))
    .sort((a, b) => Number(b.slice(prefix.length + 1, -5)) - Number(a.slice(prefix.length + 1, -5)))

function newestValidSnapshot<T>(prefix: string, valid: (v: unknown) => v is T): { value: T; file: string } | null {
  for (const f of snapshots(prefix)) {
    const r = readValid(path.join(dirs.history, f), valid)
    if (r.ok) return { value: r.value, file: f }
  }
  return null
}

/** Read a state file; if it exists but can't be used, set it aside and fall back to a snapshot. */
function load<T>(file: string, what: string, prefix: string, valid: (v: unknown) => v is T): T | null {
  const r = readValid(file, valid)
  if (r.ok) return r.value
  if (r.missing) return null
  const corruptCopy = setAside(file)
  const snap = newestValidSnapshot(prefix, valid)
  if (snap) writeJsonAtomic(file, snap.value)
  recovered({ what, corruptCopy, snapshot: snap?.file })
  return snap?.value ?? null
}

const appFile = path.join(dirs.root, 'app.json')
let app: AppFile = load(appFile, 'app', 'app', validApp) ?? { schema: SCHEMA_VERSION, settings: DEFAULT_SETTINGS, projects: [], global: {} }
app.settings = { ...DEFAULT_SETTINGS, ...app.settings }
app.projects = (app.projects ?? []).filter((m) => isObj(m) && typeof m.id === 'string' && typeof m.path === 'string')
app.global = isObj(app.global) ? app.global : {}

const lastSnapshot = new Map<string, number>()
let lastAppSnapshot = 0

/** Keep the newest `keep` snapshots of `prefix`. */
function prune(prefix: string, keep: number) {
  for (const f of snapshots(prefix).slice(keep)) fs.rmSync(path.join(dirs.history, f), { force: true })
}

function saveApp() {
  writeJsonAtomic(appFile, app)
  // settings and the project list deserve snapshots too
  const now = Date.now()
  if (now - lastAppSnapshot > 30 * 60_000) {
    lastAppSnapshot = now
    fs.copyFileSync(appFile, path.join(dirs.history, `app-${now}.json`))
    prune('app', 10)
  }
}

export const getSettings = () => app.settings
/** Same folder, same id: on Windows C:\\Repo, c:/repo and C:/Repo are one folder. */
export const projectIdFor = (p: string) => {
  const abs = path.resolve(p)
  return crypto.createHash('sha1').update(process.platform === 'win32' ? abs.toLowerCase() : abs).digest('hex').slice(0, 12)
}
const projectFile = (id: string) => path.join(dirs.projects, `${id}.json`)

/**
 * The schema number a file on disk carries, or null when it has none or cannot be read.
 *
 * Nothing read it before: a board written by a newer Fleetboard loaded as though it were this
 * version's, every field that version had added was dropped by the fill-in pass below, and the next
 * save stamped `schema` back to SCHEMA_VERSION — a silent one-way downgrade of the user's board, in
 * the one file the app has no other copy of.
 */
function schemaOf(file: string): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObj(v) && Number.isFinite(v.schema) ? Number(v.schema) : null
  } catch {
    return null
  }
}

/** Written by a Fleetboard newer than this one, so this build must not touch it. */
export const tooNew = (schema: number | null): schema is number => schema !== null && schema > SCHEMA_VERSION

export function loadProject(id: string): Project | null {
  if (!/^[\w-]+$/.test(id)) return null
  const onDisk = schemaOf(projectFile(id))
  if (tooNew(onDisk)) {
    // left alone, not set aside: the file is not damaged, this build is simply too old to read it
    recovered({ what: id, corruptCopy: '', tooNew: onDisk })
    return null
  }
  const p = load(projectFile(id), id, id, validProject)
  if (!p) return null
  // an older or hand-edited file can lack parts the board expects: fill them in rather than crash
  for (const w of p.workspaces) {
    w.name = typeof w.name === 'string' ? w.name : 'Workspace'
    w.nodes = w.nodes.filter((n) => isObj(n) && typeof n.id === 'string' && typeof n.type === 'string')
    for (const n of w.nodes) {
      n.data = isObj(n.data) ? n.data : {}
      for (const [k, d] of [['x', 0], ['y', 0], ['z', 0]] as const) if (!Number.isFinite(n[k])) (n as any)[k] = d
      for (const [k, d] of [['w', 480], ['h', 320]] as const) if (!Number.isFinite(n[k]) || n[k] <= 0) (n as any)[k] = d
    }
    for (const k of ['groups', 'wires', 'ink'] as const) if (!Array.isArray(w[k])) (w as any)[k] = []
    if (!isObj(w.camera) || ![w.camera.x, w.camera.y, w.camera.zoom].every((n) => Number.isFinite(n) && n !== null)) w.camera = { x: 0, y: 0, zoom: 1 } as Workspace['camera']
    w.extras = isObj(w.extras) ? w.extras : {}
  }
  if (!p.workspaces.some((w) => w.id === p.activeWorkspaceId)) p.activeWorkspaceId = p.workspaces[0].id
  p.extras = isObj(p.extras) ? p.extras : {}
  return p
}

let current: Project | null = null
/** The board open in the window (the last one saved), for features outside it such as the phone Inbox. */
export const currentProject = () => current

export function saveProject(p: Project) {
  // never let a broken renderer state replace a good board on disk
  if (!validProject(p) || !/^[\w-]+$/.test(p.id)) throw new Error('refusing to save an invalid project')
  // and never write an older shape over a board a newer Fleetboard saved
  const onDisk = schemaOf(projectFile(p.id))
  if (tooNew(onDisk)) throw new Error(`This board was saved by a newer version of Fleetboard (board format ${onDisk}, this one writes ${SCHEMA_VERSION}). Update Fleetboard to open it.`)
  current = p
  p.schema = SCHEMA_VERSION
  writeJsonAtomic(projectFile(p.id), p)
  const consoles = p.workspaces.reduce((n, w) => n + w.nodes.filter((x) => x.type === 'console').length, 0)
  const meta: ProjectMeta = { id: p.id, name: p.name, path: p.path, lastOpened: p.lastOpened, consoles }
  app.projects = [meta, ...app.projects.filter((m) => m.id !== p.id)]
  saveApp()
  const now = Date.now()
  if (now - (lastSnapshot.get(p.id) ?? 0) > 5 * 60_000) {
    lastSnapshot.set(p.id, now)
    fs.copyFileSync(projectFile(p.id), path.join(dirs.history, `${p.id}-${now}.json`))
    prune(p.id, 30)
  }
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  emit = ctx.emit
  ipc.handle('store:recoveries', () => recoveries)
  ipc.handle('store:settings', () => app.settings)
  ipc.handle('store:setSettings', (_e, patch: Partial<Settings>) => {
    app.settings = { ...app.settings, ...patch }
    saveApp()
    return app.settings
  })
  ipc.handle('store:projects', () =>
    app.projects.filter((m) => fs.existsSync(m.path)).sort((a, b) => b.lastOpened - a.lastOpened)
  )
  ipc.handle('store:projectId', (_e, p: string) => projectIdFor(p))
  ipc.handle('store:loadProject', (_e, id: string) => loadProject(id))
  ipc.handle('store:saveProject', (_e, p: Project) => saveProject(p))
  ipc.handle('store:forgetProject', (_e, id: string) => {
    app.projects = app.projects.filter((m) => m.id !== id)
    saveApp()
  })
  ipc.handle('store:getGlobal', (_e, key: string) => app.global[key])
  ipc.handle('store:setGlobal', (_e, key: string, value: unknown) => {
    app.global[key] = value
    saveApp()
  })
}
