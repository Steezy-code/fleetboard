// Every filesystem handler, from outside the allowed folders and from inside them. The shape of a
// refusal matters as much as the refusal: callers rely on fs:stat returning null for a path that is
// not there and on an unreadable folder being an empty tree, so a guard that threw instead would
// break a file node on a missing path. Writes and opens say so, because quietly not writing is worse.
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const IS_WIN = process.platform === 'win32'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confine-'))
process.env.FLEETBOARD_HOME = home
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confine-out-'))

let roots: typeof import('../../src/main/roots')
let project: string
/** a real file outside every root, standing in for ~/.ssh/id_ed25519 */
let secret: string

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
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confine-proj-'))
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'inside\n')
  secret = path.join(outside, 'id_ed25519')
  fs.writeFileSync(secret, 'PRIVATE KEY\n')

  roots = await import('../../src/main/roots')
  const store = await import('../../src/main/store')
  const fsops = await import('../../src/main/fsops')
  const goal = await import('../../src/main/goal')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  const ctx = { ipc: ipcMain as never, win: () => null, ptys: null as never, settings: () => DEFAULT_SETTINGS, emit: () => {} }
  store.register(ctx)
  fsops.register(ctx)
  goal.register(ctx)
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true })
  fs.writeFileSync(path.join(home, 'projects', 'proj1.json'), JSON.stringify(board('proj1', project)))
  assert.ok(store.loadProject('proj1'), 'the project opened')
})

beforeEach(() => roots.resetGrantsForTest())

test('a path inside the project still works, through every handler', async () => {
  const file = path.join(project, 'src', 'a.ts')
  assert.equal(await ipcMain.invoke('fs:read', file), 'inside\n')
  assert.equal(await ipcMain.invoke('fs:exists', file), true)
  assert.equal((await ipcMain.invoke('fs:stat', file)).dir, false)
  assert.deepEqual(
    (await ipcMain.invoke('fs:tree', path.join(project, 'src'), 1)).map((e: { name: string }) => e.name),
    ['a.ts']
  )
  assert.deepEqual((await ipcMain.invoke('fs:write', file, 'changed\n')).ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed\n')
  await ipcMain.invoke('fs:mkdir', path.join(project, 'made'))
  assert.ok(fs.existsSync(path.join(project, 'made')))
  await ipcMain.invoke('fs:writeBase64', path.join(project, 'bin.dat'), Buffer.from('hi').toString('base64'))
  assert.equal(fs.readFileSync(path.join(project, 'bin.dat'), 'utf8'), 'hi')
})

test('~/.fleetboard works too — Settings reveals it, and pictures dropped on a board live there', async () => {
  fs.mkdirSync(path.join(home, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(home, 'assets', 'pic.png'), 'png')
  assert.equal(await ipcMain.invoke('fs:exists', path.join(home, 'assets', 'pic.png')), true)
  assert.equal(await ipcMain.invoke('shell:openPath', home), '', 'the root itself, not only what is in it')
})

test('but not its private parts: sign-ins, tokens, the board files and app.json are main’s alone', async () => {
  fs.mkdirSync(path.join(home, 'profiles', 'work'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'work', '.credentials.json'), '{"token":"x"}')
  await assert.rejects(() => ipcMain.invoke('fs:read', path.join(home, 'profiles', 'work', '.credentials.json')), /Outside the folders/)
  assert.equal(await ipcMain.invoke('fs:exists', path.join(home, 'projects', 'proj1.json')), false)
  // app.json holds the grants: writing it would be a way round mainOwnedGlobal after a restart
  await assert.rejects(() => ipcMain.invoke('fs:write', path.join(home, 'app.json'), '{}'), /Outside the folders/)
  await assert.rejects(() => ipcMain.invoke('fs:write', path.join(home, 'hooks', 'fb-hook.cjs'), 'evil'), /Outside the folders/)
})

test('a read outside the roots is refused, in the shape each caller expects', async () => {
  // fs:read already throws for a missing file, so a throw is what callers handle
  await assert.rejects(() => ipcMain.invoke('fs:read', secret), /Outside the folders/)
  // these must stay quiet: a file node on a path that is gone relies on it
  assert.equal(await ipcMain.invoke('fs:stat', secret), null)
  assert.equal(await ipcMain.invoke('fs:exists', secret), false)
  assert.deepEqual(await ipcMain.invoke('fs:tree', outside, 2), [])
  // and the file is untouched either way
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PRIVATE KEY\n')
})

test('a write outside the roots is refused loudly, and writes nothing', async () => {
  const target = path.join(outside, 'planted.sh')
  await assert.rejects(() => ipcMain.invoke('fs:write', target, 'rm -rf /\n'), /Outside the folders/)
  await assert.rejects(() => ipcMain.invoke('fs:writeBase64', target, Buffer.from('x').toString('base64')), /Outside the folders/)
  await assert.rejects(() => ipcMain.invoke('fs:mkdir', path.join(outside, 'made')), /Outside the folders/)
  assert.equal(fs.existsSync(target), false, 'nothing was written')
  assert.equal(fs.existsSync(path.join(outside, 'made')), false)
  // overwriting an existing file outside is refused as well
  await assert.rejects(() => ipcMain.invoke('fs:write', secret, 'replaced\n'), /Outside the folders/)
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PRIVATE KEY\n')
})

test('opening and revealing outside the roots does neither', async () => {
  const { calls } = await import('../support/electron-stub')
  const before = calls.length
  assert.match(await ipcMain.invoke('shell:openPath', secret), /Outside the folders/)
  const listener = ipcMain.listeners.get('shell:showItem')
  void listener
  await ipcMain.invoke('shell:showItem', secret)
  assert.deepEqual(
    calls.slice(before).filter((c) => c.api.startsWith('shell.')),
    [],
    'neither opened nor revealed'
  )
})

test('a path the user picked becomes usable, and only then', async () => {
  // its own folder: a granted file opens its siblings, so sharing one would blur the tests
  const dir = fs.mkdtempSync(path.join(outside, 'picked-'))
  const picked = path.join(dir, 'picked.png')
  fs.writeFileSync(picked, 'png')
  assert.equal(await ipcMain.invoke('fs:exists', picked), false, 'not yet')

  // what dialog:openFile does with its result
  roots.grant(picked)
  assert.equal(await ipcMain.invoke('fs:exists', picked), true)
  assert.equal(await ipcMain.invoke('fs:read', picked), 'png')
  assert.equal((await ipcMain.invoke('fs:stat', picked)).size, 3)
  // and a save target chosen next to it
  const report = path.join(dir, 'report.pdf')
  roots.grant(report)
  assert.deepEqual((await ipcMain.invoke('fs:write', report, 'pdf-ish')).ok, true)
})

test('a file dropped on the board is granted by the preload, not by the renderer asking', async () => {
  // the preload sends this when getPathForFile resolves a real file; Electron returns '' for a File
  // built in JS, so a renderer cannot use it to name an arbitrary path
  const dropped = path.join(fs.mkdtempSync(path.join(outside, 'drop-')), 'dropped.png')
  fs.writeFileSync(dropped, 'png')
  assert.equal(await ipcMain.invoke('fs:stat', dropped), null, 'not yet')

  const onDropped = ipcMain.listeners.get('fs:grantDropped')
  assert.ok(onDropped, 'the preload has somewhere to send it')
  onDropped({}, dropped)
  assert.equal((await ipcMain.invoke('fs:stat', dropped)).size, 3, 'the drop made it usable')
  assert.equal(await ipcMain.invoke('fs:read', dropped), 'png')
})

test('a dropped folder never grants the disk, the home folder or above it', async () => {
  // the grant outlives the session: one of these would switch confinement off for good
  const onDropped = ipcMain.listeners.get('fs:grantDropped')!
  const before = roots.allowedRoots()
  for (const wide of [path.parse(process.cwd()).root, os.homedir(), path.dirname(os.homedir())]) onDropped({}, wide)
  assert.deepEqual(roots.allowedRoots(), before)
})

test('a refusal is logged, so a wrong root is diagnosable', async () => {
  const log = path.join(home, 'logs', 'main.log')
  await ipcMain.invoke('fs:stat', path.join(fs.mkdtempSync(path.join(outside, 'log-')), 'curious.txt'))
  assert.ok(fs.existsSync(log), 'there is a log')
  const text = fs.readFileSync(log, 'utf8')
  assert.match(text, /roots: fs:stat refused/)
  assert.match(text, /curious\.txt/)
})

test('the renderer cannot grant itself a path through the global store', async () => {
  // store:setGlobal takes any key, and the grants are a global — so without a reserved key this
  // one call would hand the renderer every path it wants and the rest of this file would be theatre
  const dir = fs.mkdtempSync(path.join(outside, 'forged-'))
  const file = path.join(dir, 'forged.txt')
  fs.writeFileSync(file, 'nope')
  await ipcMain.invoke('store:setGlobal', 'fsGrants', [{ path: dir, dir: true }])
  roots.reloadGrantsForTest()
  assert.equal(await ipcMain.invoke('fs:exists', file), false, 'still outside')
  await assert.rejects(() => ipcMain.invoke('fs:read', file), /Outside the folders/)
  // and the real grants were not replaced either
  assert.deepEqual(await ipcMain.invoke('store:getGlobal', 'fsGrants'), [])
})

test("a loop's goal check only runs in a folder Fleetboard may touch", async () => {
  // The command is the user's own — that is what a loop's goal is — but the folder arrives over IPC,
  // and a loop is stored in the board file. This handler runs `$SHELL -lc <command>` for up to
  // fifteen minutes, which makes it the sharpest thing on the surface.
  await assert.rejects(() => ipcMain.invoke('goal:check', outside, 'true'), /Outside the folders/)
  const r = await ipcMain.invoke('goal:check', project, IS_WIN ? 'exit 0' : 'true')
  assert.equal(r.code, 0, JSON.stringify(r))
})

test('a relative path is checked and used as the same file: the project’s, never the app’s working folder', async () => {
  // the check resolved it against the project; fs then resolved it against process.cwd(), so a name
  // that exists in the project passed and the same name in the working folder (often the home
  // folder) was read and written instead
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confine-cwd-'))
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'the working folder’s\n')
  const was = process.cwd()
  process.chdir(cwd)
  try {
    assert.equal(await ipcMain.invoke('fs:read', 'src/a.ts'), fs.readFileSync(path.join(project, 'src', 'a.ts'), 'utf8'), 'read from the project')
    await ipcMain.invoke('fs:write', 'src/b.ts', 'new\n')
    assert.equal(fs.readFileSync(path.join(project, 'src', 'b.ts'), 'utf8'), 'new\n', 'written into the project')
    assert.equal(fs.existsSync(path.join(cwd, 'src', 'b.ts')), false, 'and not into the working folder')
    assert.equal(await ipcMain.invoke('fs:exists', 'src/b.ts'), true)
    assert.equal((await ipcMain.invoke('fs:stat', 'src/a.ts'))?.size, fs.statSync(path.join(project, 'src', 'a.ts')).size)
    await assert.rejects(ipcMain.invoke('fs:read', '../../' + path.relative(path.resolve(project, '../..'), secret)), /Outside/, 'climbing out is still refused')
  } finally {
    process.chdir(was)
  }
})
