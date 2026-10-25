import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Project, ProjectMeta, Recovery, Settings, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@shared/types'
import type { MainContext } from './context'
import { declareProject, declaredProject, mainOwnedGlobal } from './roots'
import { dirs, writeJsonAtomic } from './paths'
import { logError } from './errors'

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

/** Windows and macOS compare folders without regard to case (roots.ts does the same). */
const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)

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

type Read<T> = { ok: true; value: T } | { ok: false; missing: boolean; error?: NodeJS.ErrnoException }
function readValid<T>(file: string, valid: (v: unknown) => v is T): Read<T> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    // Only "not there" is "nothing saved yet". EACCES, a Windows sharing lock, EMFILE or EIO is a file
    // that may be perfectly good: it must be neither set aside nor replaced by an empty one.
    const err = e as NodeJS.ErrnoException
    return err?.code === 'ENOENT' ? { ok: false, missing: true } : { ok: false, missing: false, error: err }
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
  if (r.error)
    throw new Error(`${what === 'app' ? 'The settings file' : "This board's file"} could not be read (${r.error.code ?? r.error.message}). It was left untouched and not opened; try again.`)
  const corruptCopy = setAside(file)
  const snap = newestValidSnapshot(prefix, valid)
  if (snap) writeJsonAtomic(file, snap.value)
  recovered({ what, corruptCopy, snapshot: snap?.file })
  return snap?.value ?? null
}

const appFile = path.join(dirs.root, 'app.json')
// app.json there but unreadable at startup: run on defaults and never write over it this session
let appUnreadable = false
let app: AppFile = (() => {
  // A read error that is not "not there" is often brief — a Windows sharing lock from antivirus or a
  // backup tool — and on its own it switched saving off for the whole session. Tried a few times first.
  for (let attempt = 0; ; attempt++) {
    try {
      return load(appFile, 'app', 'app', validApp)
    } catch (e) {
      if (attempt < 4) {
        const until = Date.now() + 50 * (attempt + 1)
        while (Date.now() < until) {
          /* a short synchronous wait: this runs once, before anything else reads settings */
        }
        continue
      }
      appUnreadable = true
      logError('store', e)
      recovered({ what: 'app', corruptCopy: '', unreadable: true })
      return null
    }
  }
})() ?? { schema: SCHEMA_VERSION, settings: DEFAULT_SETTINGS, projects: [], global: {} }
app.settings = { ...DEFAULT_SETTINGS, ...app.settings }
app.projects = (app.projects ?? []).filter((m) => isObj(m) && typeof m.id === 'string' && typeof m.path === 'string')
app.global = isObj(app.global) ? app.global : {}

const lastSnapshot = new Map<string, number>()
let lastAppSnapshot = 0

/** The local day a snapshot was taken, from its name. */
const dayOf = (prefix: string, f: string) => new Date(Number(f.slice(prefix.length + 1, -5))).toDateString()

/**
 * Keep the newest `keep` snapshots of `prefix`, and the newest of each of the last `days` days besides.
 *
 * The newest alone is a couple of hours at a five-minute cadence: a board emptied by a bug that still
 * passed validation would have rotated every good copy out by evening. One a day for two weeks is
 * what lets yesterday's board come back.
 */
export function prune(prefix: string, keep: number, days = 14) {
  const all = snapshots(prefix)
  const kept = new Set(all.slice(0, keep))
  const seen = new Set<string>()
  for (const f of all) {
    const day = dayOf(prefix, f)
    if (seen.has(day)) continue
    seen.add(day)
    if (seen.size > days) break
    kept.add(f)
  }
  for (const f of all) if (!kept.has(f)) fs.rmSync(path.join(dirs.history, f), { force: true })
}

function saveApp() {
  if (appUnreadable) return
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
  // Asked before every save, which is every pause in typing; reading and parsing a whole board each
  // time held up the main process, which also carries every console's output. The answer only
  // changes when the file does, so it is kept against the file's size and time.
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    schemas.delete(file)
    return null
  }
  const known = schemas.get(file)
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.schema
  let schema: number | null = null
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    schema = isObj(v) && Number.isFinite(v.schema) ? Number(v.schema) : null
  } catch {
    /* unreadable: no schema */
  }
  schemas.set(file, { schema, size: st.size, mtimeMs: st.mtimeMs })
  return schema
}
const schemas = new Map<string, { schema: number | null; size: number; mtimeMs: number }>()

/** Written by a Fleetboard newer than this one, so this build must not touch it. */
export const tooNew = (schema: number | null): schema is number => schema !== null && schema > SCHEMA_VERSION

let current: Project | null = null
/** The board open in the window, for features outside it: the phone Inbox, and the roots the
 *  filesystem handlers allow (roots.ts). Set when a board is opened and on every save. */
export const currentProject = () => current

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
  // every board has a workspace: one was put there above if the file had none
  const firstWs = p.workspaces[0]
  if (firstWs && !p.workspaces.some((w) => w.id === p.activeWorkspaceId)) p.activeWorkspaceId = firstWs.id
  p.extras = isObj(p.extras) ? p.extras : {}
  // the board being opened is the current one from now on, not only once it is first saved: the
  // filesystem handlers take their project root from here (roots.ts), and the file tree reads before
  // anything has been saved
  current = p
  return p
}

/** A global (cross-project) value. The renderer uses store:getGlobal; this is for main's own modules. */
export const getGlobal = <T,>(key: string): T | undefined => app.global[key] as T | undefined

/** Store a global value and persist it. */
export function setGlobal(key: string, value: unknown) {
  app.global[key] = value
  saveApp()
}

export function saveProject(p: Project) {
  // never let a broken renderer state replace a good board on disk
  if (!validProject(p) || !/^[\w-]+$/.test(p.id)) throw new Error('refusing to save an invalid project')
  // and never write an older shape over a board a newer Fleetboard saved
  const onDisk = schemaOf(projectFile(p.id))
  if (tooNew(onDisk)) throw new Error(`This board was saved by a newer version of Fleetboard (board format ${onDisk}, this one writes ${SCHEMA_VERSION}). Update Fleetboard to open it.`)
  // Saving a board is not opening it. The page saves the board it is leaving in the background just
  // after it has declared the next one, and that save used to make the old board current again — the
  // old folder was then the only project root, and nothing could be read or started in the new one.
  const declaredNow = declaredProject()
  if (!declaredNow || fold(path.resolve(p.path)) === fold(declaredNow)) current = p
  p.schema = SCHEMA_VERSION
  // The board is saved here. Everything after this is bookkeeping — the recent-projects list and a
  // periodic snapshot — and none of it may be reported as "the board could not be saved", which is
  // what the caller does with a throw. On a full disk that message was a lie, and it came with the
  // pruning that would have freed the space never running.
  writeJsonAtomic(projectFile(p.id), p)
  try {
    const consoles = p.workspaces.reduce((n, w) => n + w.nodes.filter((x) => x.type === 'console').length, 0)
    const meta: ProjectMeta = { id: p.id, name: p.name, path: p.path, lastOpened: p.lastOpened, consoles }
    // app.json only when its entry for this board changed: rewriting (and fsyncing) it on every save
    // of an unchanged list doubled the cost of each one
    const was = app.projects[0]
    if (!was || JSON.stringify(was) !== JSON.stringify(meta)) {
      app.projects = [meta, ...app.projects.filter((m) => m.id !== p.id)]
      saveApp()
    }
  } catch (e) {
    logError('store', e)
  }
  const now = Date.now()
  if (now - (lastSnapshot.get(p.id) ?? 0) > 5 * 60_000) {
    // recorded even if the copy fails, so a full disk is not retried on every keystroke
    lastSnapshot.set(p.id, now)
    try {
      fs.copyFileSync(projectFile(p.id), path.join(dirs.history, `${p.id}-${now}.json`))
    } catch (e) {
      logError('store', e)
    }
    // after the copy and whether or not it worked: this is the step that frees space, so the time it
    // is needed most is exactly the time the copy just failed
    try {
      prune(p.id, 30)
    } catch (e) {
      logError('store', e)
    }
  }
}

/**
 * What a crash or a full disk leaves behind: a temporary file from a write that never got renamed,
 * and the set-aside copies of unreadable files. Kept a while for rescue by hand, then cleared, so
 * neither grows without end.
 */
export function sweepLeftovers(now = Date.now()) {
  const DAY = 86_400_000
  for (const dir of [dirs.root, dirs.projects, dirs.history]) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of names) {
      const age = f.endsWith('.tmp') ? DAY : /\.corrupt-\d+\.json$/.test(f) ? 30 * DAY : 0
      if (!age) continue
      try {
        const file = path.join(dir, f)
        if (now - fs.statSync(file).mtimeMs > age) fs.rmSync(file, { force: true })
      } catch {
        /* gone meanwhile, or not ours to remove */
      }
    }
  }
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  emit = ctx.emit
  try {
    sweepLeftovers()
  } catch (e) {
    logError('store', e)
  }
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
  ipc.handle('store:projectId', (_e, p: string) => {
    // the first thing openProject does, and the only point before any read where the folder being
    // opened is named — a brand-new folder has no saved board to take it from (see roots.ts)
    const opening = declareProject(p)
    // A different folder is being opened, so the board loaded before is not "the open one" any more.
    // For a folder with a saved board loadProject makes that one current next; for a brand-new folder
    // nothing does until its first save, and projectRoot() preferred the old board's folder over the
    // declared one meanwhile: a team could not be started, nor a file read, in a folder just opened.
    if (opening && current && fold(path.resolve(current.path)) !== fold(opening)) current = null
    return projectIdFor(p)
  })
  ipc.handle('store:loadProject', (_e, id: string) => {
    // A board this build must not touch is not the same answer as "there is no board yet", and the
    // renderer used to get null for both: it then made an empty board *with the same id*, which every
    // save refused, so the user was left looking at a blank board that could never keep anything.
    const schema = schemaOf(projectFile(String(id)))
    if (tooNew(schema))
      throw new Error(
        `This board was saved by a newer version of Fleetboard (board format ${schema}; this one reads ${SCHEMA_VERSION}). It was left untouched and not opened. Update Fleetboard to open it.`
      )
    return loadProject(String(id))
  })
  ipc.handle('store:saveProject', (_e, p: Project) => saveProject(p))
  ipc.handle('store:forgetProject', (_e, id: string) => {
    app.projects = app.projects.filter((m) => m.id !== id)
    saveApp()
    // its snapshots go with it: nothing lists them any more, and nothing else would ever remove them
    if (/^[\w-]+$/.test(id)) {
      try {
        for (const f of snapshots(id)) fs.rmSync(path.join(dirs.history, f), { force: true })
      } catch (e) {
        logError('store', e)
      }
    }
  })
  ipc.handle('store:getGlobal', (_e, key: string) => getGlobal(key))
  ipc.handle('store:setGlobal', (_e, key: string, value: unknown) => {
    // a few globals are main's own (roots.ts); everything else here is the renderer's to keep
    if (mainOwnedGlobal(key)) return
    setGlobal(key, value)
  })
}
