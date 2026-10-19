// Persistence: a state file that can't be read is set aside and the newest good snapshot is used,
// never silently replaced by an empty board or default settings.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-store-'))
const history = path.join(home, 'history')
const projects = path.join(home, 'projects')
const emitted: unknown[][] = []
let store: typeof import('../../src/main/store')

const board = (id: string, name: string) => ({
  schema: 1,
  id,
  name,
  path: `/tmp/${name}`,
  activeWorkspaceId: 'ws1',
  lastOpened: 1,
  extras: {},
  workspaces: [{ id: 'ws1', name: 'Workspace 1', nodes: [{ id: 'n1', type: 'note', x: 0, y: 0, w: 100, h: 100, data: {} }], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
})

before(async () => {
  for (const d of [history, projects]) fs.mkdirSync(d, { recursive: true })
  // app.json was cut off mid-write; an older good copy is in history/
  fs.writeFileSync(path.join(home, 'app.json'), '{"schema":1,"settings":{"names":["Ad')
  fs.writeFileSync(path.join(history, 'app-1000.json'), JSON.stringify({ schema: 1, settings: { names: ['Old'] }, projects: [], global: {} }))
  fs.writeFileSync(path.join(history, 'app-2000.json'), JSON.stringify({ schema: 1, settings: { names: ['Ada', 'Bo'], autoApprove: true }, projects: [{ id: 'p1', name: 'one', path: '/tmp/one', lastOpened: 1, consoles: 0 }], global: { k: 1 } }))
  fs.writeFileSync(path.join(history, 'app-3000.json'), '{ also broken')
  process.env.FLEETBOARD_HOME = home
  store = await import('../../src/main/store')
  store.register({ ipc: ipcMain as any, win: () => null, ptys: null as any, settings: store.getSettings, emit: (...a: unknown[]) => void emitted.push(a) })
})

test('a broken app.json is set aside and the newest readable snapshot restored', async () => {
  assert.deepEqual(store.getSettings().names, ['Ada', 'Bo'])
  assert.equal(store.getSettings().autoApprove, true)
  const corrupt = fs.readdirSync(home).filter((f) => /^app\.corrupt-\d+\.json$/.test(f))
  assert.equal(corrupt.length, 1, 'the damaged file is kept')
  assert.equal(fs.readFileSync(path.join(home, corrupt[0]), 'utf8'), '{"schema":1,"settings":{"names":["Ad')
  const recoveries = await ipcMain.invoke('store:recoveries')
  assert.deepEqual(recoveries, [{ what: 'app', corruptCopy: path.join(home, corrupt[0]), snapshot: 'app-2000.json' }])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'app.json'), 'utf8')).settings.names, ['Ada', 'Bo'], 'the restored copy is written back')
})

test('a broken project file is set aside and its newest good snapshot loaded', () => {
  const id = 'aaaaaaaaaaaa'
  fs.writeFileSync(path.join(projects, `${id}.json`), '\0\0\0\0')
  fs.writeFileSync(path.join(history, `${id}-5000.json`), JSON.stringify(board(id, 'older')))
  fs.writeFileSync(path.join(history, `${id}-9000.json`), JSON.stringify(board(id, 'newest')))
  fs.writeFileSync(path.join(history, `${id}-9999.json`), JSON.stringify({ id, workspaces: 'nope' }))
  const p = store.loadProject(id)
  assert.equal(p?.name, 'newest')
  assert.ok(fs.readdirSync(projects).some((f) => f.startsWith(`${id}.corrupt-`)))
  assert.equal(emitted.at(-1)?.[0], 'store:recovered')
  assert.deepEqual((emitted.at(-1)?.[1] as any).snapshot, `${id}-9000.json`)
  // and the next load reads the restored file normally
  assert.equal(store.loadProject(id)?.name, 'newest')
})

test('a broken project without snapshots: kept aside, not overwritten by the new empty board', () => {
  const id = 'bbbbbbbbbbbb'
  fs.writeFileSync(path.join(projects, `${id}.json`), '{"id": "bbbb", "workspa')
  assert.equal(store.loadProject(id), null)
  const aside = fs.readdirSync(projects).filter((f) => f.startsWith(`${id}.corrupt-`))
  assert.equal(aside.length, 1)
  assert.equal(fs.readFileSync(path.join(projects, aside[0]), 'utf8'), '{"id": "bbbb", "workspa')
})

test('a missing project is simply new (no recovery noise)', () => {
  const before = emitted.length
  assert.equal(store.loadProject('cccccccccccc'), null)
  assert.equal(emitted.length, before)
})

test('older files missing parts of a workspace are filled in', () => {
  const id = 'dddddddddddd'
  const old: any = board(id, 'old')
  delete old.workspaces[0].ink
  delete old.workspaces[0].camera
  old.workspaces[0].nodes.push(null, { id: 'x' })
  old.activeWorkspaceId = 'gone'
  fs.writeFileSync(path.join(projects, `${id}.json`), JSON.stringify(old))
  const p = store.loadProject(id)!
  assert.deepEqual(p.workspaces[0].ink, [])
  assert.deepEqual(p.workspaces[0].camera, { x: 0, y: 0, zoom: 1 })
  assert.equal(p.workspaces[0].nodes.length, 1, 'unusable nodes dropped')
  assert.equal(p.activeWorkspaceId, 'ws1')
})

test('tiles with missing or odd data and geometry are filled in', () => {
  const id = 'eeeeeeeeeeee'
  const old: any = board(id, 'odd')
  old.workspaces[0].nodes = [
    { id: 'a', type: 'web', data: null, x: 'left', y: null, w: -5, h: 'tall' },
    { id: 'b', type: 'note', x: 10, y: 20, w: 200, h: 150, z: 3, data: { text: 'kept' } }
  ]
  fs.writeFileSync(path.join(projects, `${id}.json`), JSON.stringify(old))
  const [a, b] = store.loadProject(id)!.workspaces[0].nodes
  assert.deepEqual([a.data, a.x, a.y, a.z, a.w, a.h], [{}, 0, 0, 0, 480, 320])
  assert.deepEqual([b.data, b.x, b.y, b.z, b.w, b.h], [{ text: 'kept' }, 10, 20, 3, 200, 150])
})

test('saving refuses an invalid project instead of replacing a good board', () => {
  const id = 'eeeeeeeeeeee'
  store.saveProject(board(id, 'good') as any)
  assert.throws(() => store.saveProject({ id, workspaces: [] } as any), /invalid project/)
  assert.throws(() => store.saveProject({ ...board('../escape', 'x') } as any), /invalid project/)
  assert.equal(store.loadProject(id)?.name, 'good')
})

test('project ids that are not file names are rejected', () => {
  assert.equal(store.loadProject('../app'), null)
})
