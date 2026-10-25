// Which paths the filesystem handlers may touch. fsops.ts used to take any absolute path, so this is
// the whole of the new answer — and the ways it can be subtly wrong (a separator, a case, a `..`, a
// path that does not exist yet) are exactly the ways it would either let something through or break a
// working feature.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-roots-'))
process.env.FLEETBOARD_HOME = home
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-outside-'))

let roots: typeof import('../../src/main/roots')
let store: typeof import('../../src/main/store')
let project: string

const FOLDS = process.platform === 'win32' || process.platform === 'darwin'

const board = (id: string, p: string) => ({
  schema: 1,
  id,
  name: 'p',
  path: p,
  activeWorkspaceId: 'ws1',
  lastOpened: 1,
  extras: {},
  workspaces: [{ id: 'ws1', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
})

before(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-project-'))
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'x')
  roots = await import('../../src/main/roots')
  store = await import('../../src/main/store')
  // loadProject sets the current board, which is where the project root comes from
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true })
  fs.writeFileSync(path.join(home, 'projects', 'proj1.json'), JSON.stringify(board('proj1', project)))
  assert.ok(store.loadProject('proj1'), 'the project opened')
})

beforeEach(() => roots.resetGrantsForTest())

test('the open project and ~/.fleetboard are allowed, including the roots themselves', () => {
  for (const p of [project, path.join(project, 'src', 'a.ts'), path.join(project, 'src'), home, path.join(home, 'assets', 'pic.png'), path.join(home, 'exports', 'doc.pdf')]) {
    assert.equal(roots.insideAllowed(p), true, p)
  }
  // ~/.fleetboard's private parts are not, from any root
  for (const p of [path.join(home, 'app.json'), path.join(home, 'projects', 'proj1.json'), path.join(home, 'profiles', 'x', '.credentials.json'), path.join(home, 'remote.json'), path.join(home, 'fleet', 'p.json'), path.join(home, 'hooks')]) {
    assert.equal(roots.insideAllowed(p), false, p)
  }
  // a file that does not exist yet, inside the project: writeText creates parents, so this must pass
  assert.equal(roots.insideAllowed(path.join(project, 'docs', 'deep', 'new.md')), true)
})

test('anywhere else is refused', () => {
  for (const p of [outside, path.join(outside, 'x.txt'), path.join(os.homedir(), '.ssh', 'id_ed25519'), '/etc/passwd']) {
    assert.equal(roots.insideAllowed(p), false, p)
  }
  // and nothing that is not a usable path
  for (const p of ['', '   ', null, undefined, 42, {}, []]) assert.equal(roots.insideAllowed(p as never), false, JSON.stringify(p))
})

test('a sibling folder cannot pass as being inside one', () => {
  // the classic prefix bug: "<project>-old" starts with "<project>"
  assert.equal(roots.insideAllowed(project + '-old'), false)
  assert.equal(roots.insideAllowed(project + '-old/x.ts'), false)
  assert.equal(roots.insideAllowed(home + '-old/app.json'), false)
})

test('.. is normalized away before the check, not after', () => {
  assert.equal(roots.insideAllowed(path.join(project, '..', 'elsewhere', 'x')), false)
  assert.equal(roots.insideAllowed(path.join(project, 'src', '..', '..', '..', 'etc', 'passwd')), false)
  // and a .. that stays inside is still inside
  assert.equal(roots.insideAllowed(path.join(project, 'src', '..', 'src', 'a.ts')), true)
  // duplicate separators and "." segments are the same path
  assert.equal(roots.insideAllowed(path.join(project, '.', 'src') + path.sep + path.sep + 'a.ts'), true)
})

test('a relative path means inside the open board, not inside the main process cwd', () => {
  // test/e2e/smoke-content.test.ts really does send 'src/app.ts'
  assert.equal(roots.absolutePath('src/a.ts'), path.join(project, 'src', 'a.ts'))
  assert.equal(roots.insideAllowed('src/a.ts'), true)
  // and a relative path that climbs out is still refused
  assert.equal(roots.insideAllowed(path.join('..', '..', 'etc', 'passwd')), false)
})

test('case is folded only where the filesystem folds it', () => {
  const shouted = path.join(project.toUpperCase(), 'src', 'a.ts')
  assert.equal(roots.insideAllowed(shouted), FOLDS, `folding is ${FOLDS} on ${process.platform}`)
})

test('a granted folder opens its subtree; a granted file opens itself and its siblings only', () => {
  const picked = path.join(outside, 'picked')
  fs.mkdirSync(path.join(picked, 'deep'), { recursive: true })
  fs.writeFileSync(path.join(picked, 'image.png'), 'x')
  fs.writeFileSync(path.join(picked, 'notes.md'), 'x')
  fs.writeFileSync(path.join(picked, 'deep', 'buried.png'), 'x')

  assert.equal(roots.insideAllowed(path.join(picked, 'image.png')), false, 'not yet')

  // a file pick (dialog:openFile, or an image dropped on the board)
  roots.grant(path.join(picked, 'image.png'))
  assert.equal(roots.insideAllowed(path.join(picked, 'image.png')), true, 'the file itself')
  assert.equal(roots.insideAllowed(path.join(picked, 'notes.md')), true, 'a sibling, for relative assets')
  assert.equal(roots.insideAllowed(path.join(picked, 'deep', 'buried.png')), false, 'but not a subfolder')
  assert.equal(roots.insideAllowed(outside), false, 'and not the folder above')

  // a folder pick (dialog:openFolder), from a clean slate
  roots.resetGrantsForTest()
  roots.grant(picked)
  assert.equal(roots.insideAllowed(path.join(picked, 'deep', 'buried.png')), true, 'a folder grant is a subtree')
  assert.equal(roots.insideAllowed(path.join(outside, 'elsewhere.txt')), false, 'still not its parent')
})

test('a save target that does not exist yet is granted as a file', () => {
  // dialog:saveFile returns a path before anything is written there
  const target = path.join(outside, 'exports', 'report.pdf')
  assert.equal(roots.insideAllowed(target), false)
  roots.grant(target)
  assert.equal(roots.insideAllowed(target), true)
  assert.equal(roots.insideAllowed(path.join(outside, 'exports', 'other.pdf')), true, 'siblings in the chosen folder')
  assert.equal(roots.insideAllowed(path.join(outside, 'exports', 'sub', 'x.pdf')), false)
})

test('grants survive a restart, and cannot grow without limit', () => {
  const picked = path.join(outside, 'remembered.png')
  fs.writeFileSync(picked, 'x')
  roots.grant(picked)
  // a fresh read of the persisted list, as a later launch would do
  roots.reloadGrantsForTest()
  assert.equal(roots.insideAllowed(picked), true, 'remembered across a restart')

  for (let i = 0; i < 260; i++) roots.grant(path.join(outside, `bulk-${i}.png`))
  roots.reloadGrantsForTest()
  const kept = roots.allowedRoots()
  assert.ok(kept.length <= 202, `bounded, got ${kept.length}`)
  assert.ok(kept.includes(path.join(outside, 'bulk-259.png')), 'the newest is kept')
  assert.ok(!kept.includes(path.join(outside, 'bulk-0.png')), 'the oldest fell out of the list')
  // note: bulk-0.png is still *reachable*, as a sibling of the newest grant in the same folder.
  // That is the sibling rule working, not the bound failing.
})

test('a board that claims the whole disk as its folder gets no project root at all', () => {
  // board files live in ~/.fleetboard and are written by the agents the app runs, so the folder a
  // board names is not a folder to take on trust: `path: "/"` would otherwise allow everything
  for (const wide of ['/', os.homedir(), path.dirname(os.homedir())]) {
    fs.writeFileSync(path.join(home, 'projects', 'wide.json'), JSON.stringify(board('wide', wide)))
    assert.ok(store.loadProject('wide'), 'the board itself still opens')
    assert.equal(roots.projectRoot(), null, wide)
    assert.equal(roots.insideAllowed(path.join(os.homedir(), '.ssh', 'id_ed25519')), false, wide)
    assert.equal(roots.insideAllowed('/etc/passwd'), false, wide)
    // and ~/.fleetboard is still allowed, so the app can still read its own files
    assert.equal(roots.insideAllowed(path.join(home, 'assets', 'pic.png')), true, wide)
    assert.equal(roots.insideAllowed(path.join(home, 'app.json')), false, 'but not the private ones, even with the home folder claimed')
  }
  // back to the real project for whatever runs after this
  assert.ok(store.loadProject('proj1'))
  assert.equal(roots.projectRoot(), project)
})

test('a folder opened for the first time becomes the project root at once, not when it is first saved', async () => {
  // store:projectId is the first thing openProject does. With a board already loaded, the old
  // project's folder kept being "the open one" until the new folder had a saved board of its own —
  // so nothing could be read in it, and no team started
  const { ipcMain } = await import('../support/electron-stub')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  store.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: () => DEFAULT_SETTINGS, emit: () => {} })
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-fresh-'))
  assert.equal(roots.projectRoot(), project, 'the board loaded before')
  assert.equal(roots.insideAllowed(path.join(fresh, 'a.txt')), false, 'and its folder alone')
  await ipcMain.invoke('store:projectId', fresh)
  assert.equal(roots.projectRoot(), fresh)
  assert.equal(roots.insideAllowed(path.join(fresh, 'a.txt')), true)
  assert.equal(roots.insideAllowed(path.join(project, 'src', 'a.ts')), false, 'the previous project is not a root any more')
  // a name that is no folder changes nothing
  await ipcMain.invoke('store:projectId', path.join(fresh, 'not-there'))
  assert.equal(roots.projectRoot(), fresh)
  // back to the real project for whatever runs after this
  assert.ok(store.loadProject('proj1'))
  assert.equal(roots.projectRoot(), project)
})

test('the board being left, saved in the background after the next folder is declared, does not become the open project again', async () => {
  const { ipcMain } = await import('../support/electron-stub')
  const next = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-next-'))
  assert.ok(store.loadProject('proj1'))
  await ipcMain.invoke('store:projectId', next)
  store.saveProject(board('proj1', project) as never) // the page saving the board it just left
  assert.equal(roots.projectRoot(), next, 'the folder being opened stays the root')
  assert.equal(roots.insideAllowed(path.join(project, 'src', 'a.ts')), false)
  // saving the board of the declared folder is the normal case, and still makes it current
  store.saveProject(board('proj2', next) as never)
  assert.equal(store.currentProject()?.id, 'proj2')
  assert.ok(store.loadProject('proj1'))
  await ipcMain.invoke('store:projectId', project)
  assert.equal(roots.projectRoot(), project)
})
