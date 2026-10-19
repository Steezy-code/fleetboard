import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Project, ProjectMeta, Settings } from '@shared/types'
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@shared/types'
import type { MainContext } from './context'
import { dirs, readJson, writeJsonAtomic } from './paths'

// State lives on disk as versioned JSON: ~/.fleetboard/app.json (settings, project index, global
// values) and one file per project. Every few minutes a snapshot goes to history/ so a bad save
// can be rolled back by hand.

interface AppFile {
  schema: number
  settings: Settings
  projects: ProjectMeta[]
  global: Record<string, unknown>
}

const appFile = path.join(dirs.root, 'app.json')
let app: AppFile = readJson<AppFile>(appFile, { schema: SCHEMA_VERSION, settings: DEFAULT_SETTINGS, projects: [], global: {} })
app.settings = { ...DEFAULT_SETTINGS, ...app.settings }
app.global ??= {}

const lastSnapshot = new Map<string, number>()
const saveApp = () => writeJsonAtomic(appFile, app)

export const getSettings = () => app.settings
export const projectIdFor = (p: string) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 12)
const projectFile = (id: string) => path.join(dirs.projects, `${id}.json`)

export function loadProject(id: string): Project | null {
  return readJson<Project | null>(projectFile(id), null)
}

export function saveProject(p: Project) {
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
    const old = fs.readdirSync(dirs.history).filter((f) => f.startsWith(p.id)).sort()
    for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dirs.history, f), { force: true })
  }
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
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
