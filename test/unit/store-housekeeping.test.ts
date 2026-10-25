// What a board save costs, and what the history keeps. A save happens on every pause in typing, in
// the process that also carries every console's output; the history is the only way back from a bad
// change, so it must reach further back than the last couple of hours.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-housekeeping-'))
process.env.FLEETBOARD_HOME = home
let store: typeof import('../../src/main/store')
const { SCHEMA_VERSION } = await import('../../src/shared/types')

const board = (id: string, name: string) => ({
  schema: 1,
  id,
  name,
  path: `/tmp/${name}`,
  activeWorkspaceId: 'ws1',
  lastOpened: 1,
  extras: {},
  workspaces: [{ id: 'ws1', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
})

before(async () => {
  store = await import('../../src/main/store')
})

test('history keeps the newest snapshots and one a day for two weeks besides', () => {
  const hist = path.join(home, 'history')
  const DAY = 86_400_000
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const names: string[] = []
  // twenty days of history, three snapshots a day
  for (let d = 0; d < 20; d++) for (const h of [0, 1, 2]) names.push(`hk-${noon.getTime() - d * DAY - h * 3_600_000}.json`)
  for (const n of names) fs.writeFileSync(path.join(hist, n), '{}')
  store.prune('hk', 5)
  const left = fs.readdirSync(hist).filter((f) => f.startsWith('hk-'))
  const days = new Set(left.map((f) => new Date(Number(f.slice(3, -5))).toDateString()))
  assert.equal(days.size, 14, 'one for each of the last fourteen days')
  for (const n of names.slice(0, 5)) assert.ok(left.includes(n), `${n}: the newest five are all there`)
  assert.equal(left.length, 5 + 14 - 2, 'the newest five already cover today and yesterday')
})

test('a board written by a newer Fleetboard behind this one’s back is still never written over', () => {
  // the schema on disk is remembered between saves; a file that changed must be read again
  store.saveProject(board('hk2', 'mine') as never)
  store.saveProject(board('hk2', 'mine again') as never)
  const file = path.join(home, 'projects', 'hk2.json')
  fs.writeFileSync(file, JSON.stringify({ ...board('hk2', 'from the future'), schema: SCHEMA_VERSION + 1, extra: 'longer than before' }))
  assert.throws(() => store.saveProject(board('hk2', 'mine') as never), /newer version/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'from the future')
})

test('saving an unchanged board leaves app.json alone', () => {
  store.saveProject(board('hk3', 'same') as never)
  const appFile = path.join(home, 'app.json')
  const before = fs.statSync(appFile).mtimeMs
  const t = Date.now() + 50
  while (Date.now() < t) {
    /* let the clock move, so a rewrite would show */
  }
  store.saveProject(board('hk3', 'same') as never)
  assert.equal(fs.statSync(appFile).mtimeMs, before, 'the recent-projects entry did not change, so nothing was rewritten')
  store.saveProject(board('hk3', 'renamed') as never)
  assert.notEqual(fs.statSync(appFile).mtimeMs, before, 'and a change still is')
})

test('leftovers of old crashes are cleared, recent ones kept for rescue', () => {
  const projects = path.join(home, 'projects')
  const old = path.join(projects, 'x.json.123.tmp')
  const fresh = path.join(projects, 'y.json.456.tmp')
  const oldCorrupt = path.join(projects, 'z.corrupt-1.json')
  for (const f of [old, fresh, oldCorrupt]) fs.writeFileSync(f, 'x')
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000)
  fs.utimesSync(old, ago(2), ago(2))
  fs.utimesSync(oldCorrupt, ago(40), ago(40))
  store.sweepLeftovers()
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(oldCorrupt), false)
  assert.equal(fs.existsSync(fresh), true, 'a write may still be in flight')
})
