// saveProject writes the board, then keeps books: the recent-projects list and a periodic snapshot.
// Those used to be able to throw out of it, so a board that had already reached the disk was reported
// to the user as "Could not save the board" — and `prune`, the one step that frees space, never ran.
// On a full disk that is the worst possible combination: a false alarm, and no recovery.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bookkeeping-'))
process.env.FLEETBOARD_HOME = home
let store: typeof import('../../src/main/store')

const board = (id: string, name: string) => ({
  schema: 1,
  id,
  name,
  path: `/tmp/${name}`,
  activeWorkspaceId: 'ws1',
  lastOpened: 1,
  extras: {},
  workspaces: [{ id: 'ws1', name: 'W', nodes: [{ id: 'n1', type: 'note', x: 0, y: 0, w: 1, h: 1, data: {} }], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
})

before(async () => {
  store = await import('../../src/main/store')
})

test('a snapshot that cannot be written does not become "the board could not be saved"', () => {
  const id = 'bk1'
  // nothing can be copied into history/ while a file is sitting where the folder should be
  fs.rmSync(path.join(home, 'history'), { recursive: true, force: true })
  fs.writeFileSync(path.join(home, 'history'), 'in the way')

  assert.doesNotThrow(() => store.saveProject(board(id, 'kept') as never))
  const file = path.join(home, 'projects', `${id}.json`)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'kept', 'the board is on disk, which is what the caller was asking for')

  // and again, with a change: still saved, still no throw
  assert.doesNotThrow(() => store.saveProject(board(id, 'kept again') as never))
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'kept again')

  fs.rmSync(path.join(home, 'history'))
  fs.mkdirSync(path.join(home, 'history'), { recursive: true })
})

test('a settings file that cannot be written does not either', () => {
  const id = 'bk2'
  const appFile = path.join(home, 'app.json')
  fs.rmSync(appFile, { force: true })
  fs.mkdirSync(appFile) // a directory where the file goes: every write of it now fails

  assert.doesNotThrow(() => store.saveProject(board(id, 'still saved') as never))
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'projects', `${id}.json`), 'utf8')).name, 'still saved')

  fs.rmdirSync(appFile)
})

test('what must still throw, still throws: an invalid board, and one a newer version wrote', () => {
  assert.throws(() => store.saveProject({ id: 'x' } as never), /refusing to save an invalid project/)
  const id = 'bk3'
  store.saveProject(board(id, 'mine') as never)
  const file = path.join(home, 'projects', `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...board(id, 'theirs'), schema: 99 }))
  assert.throws(() => store.saveProject(board(id, 'mine again') as never), /newer version of Fleetboard/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'theirs', 'untouched')
})
