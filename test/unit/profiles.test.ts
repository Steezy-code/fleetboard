// Profiles put several sign-ins of one CLI side by side, each its own config dir handed to the CLI
// through its own env var (CLAUDE_CONFIG_DIR, CODEX_HOME). Getting this wrong does not throw: it
// quietly runs an agent on the wrong account, or bills the wrong subscription.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-profiles-'))
process.env.FLEETBOARD_HOME = home
// a fake user home, so nothing here reads or copies the real one
const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-userhome-'))
let profiles: typeof import('../../src/main/profiles')

const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

before(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  ;(os as { homedir: () => string }).homedir = () => userHome
  profiles = await import('../../src/main/profiles')
  profiles.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: (() => ({})) as never, emit: () => {} })
})

test('a profile points its CLI at its own config dir, through that CLI\'s own variable', async () => {
  const claude = await ipcMain.invoke('profiles:create', 'claude', 'Work account')
  const codex = await ipcMain.invoke('profiles:create', 'codex', 'Work account')

  assert.deepEqual(profiles.profileEnv('claude', claude.id), { CLAUDE_CONFIG_DIR: claude.dir })
  assert.deepEqual(profiles.profileEnv('codex', codex.id), { CODEX_HOME: codex.dir })
  // the dir is created, because the CLI will write into it
  assert.ok(fs.existsSync(claude.dir))

  // no profile means the default sign-in, untouched
  assert.deepEqual(profiles.profileEnv('claude'), {})
  // and a profile that no longer exists must fall back to the default rather than invent a dir
  assert.deepEqual(profiles.profileEnv('claude', 'claude-deleted'), {})
  // an agent with no config dir of its own cannot have profiles
  assert.deepEqual(profiles.profileEnv('aider', claude.id), { CLAUDE_CONFIG_DIR: claude.dir }, "the profile's own agent decides the variable")
  assert.deepEqual(profiles.profileEnv('aider', 'nope'), {})
})

test('ids are unique and stay usable as folder names', async () => {
  const a = await ipcMain.invoke('profiles:create', 'claude', 'Work account')
  const b = await ipcMain.invoke('profiles:create', 'claude', 'Work account')
  const odd = await ipcMain.invoke('profiles:create', 'claude', '  Ünïcødé / slashes & spaces!  ')
  const empty = await ipcMain.invoke('profiles:create', 'claude', '   ')

  for (const p of [a, b, odd, empty]) assert.match(p.id, /^[\w-]+$/, `${p.id} is a safe folder name`)
  assert.notEqual(a.id, b.id, 'the same name twice gives two profiles')
  assert.equal(empty.name, 'Profile', 'a blank name gets a default')
  assert.equal(new Set([a.id, b.id, odd.id, empty.id]).size, 4)
  assert.ok(path.resolve(a.dir).startsWith(path.resolve(home)), 'profiles live under ~/.fleetboard')
})

test('deleting a profile removes its folder, but only one we made', async () => {
  const p = await ipcMain.invoke('profiles:create', 'claude', 'Throwaway')
  fs.writeFileSync(path.join(p.dir, '.credentials.json'), '{}')
  assert.ok(fs.existsSync(p.dir))
  await ipcMain.invoke('profiles:delete', p.id)
  assert.equal(fs.existsSync(p.dir), false, 'the folder goes with it')
  assert.equal((await ipcMain.invoke('profiles:list')).find((x: { id: string }) => x.id === p.id), undefined)

  // a hand-edited index pointing somewhere else must not make the app delete that folder
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-not-ours-'))
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'important')
  const index = path.join(home, 'profiles', 'index.json')
  const list = JSON.parse(fs.readFileSync(index, 'utf8'))
  list.push({ id: 'evil', agentId: 'claude', name: 'Evil', dir: outside, createdAt: 1 })
  fs.writeFileSync(index, JSON.stringify(list))
  await ipcMain.invoke('profiles:delete', 'evil')
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'a folder outside ~/.fleetboard/profiles is left alone')
})

test('renaming keeps the id, and a blank name is refused', async () => {
  const p = await ipcMain.invoke('profiles:create', 'claude', 'Before')
  const after = await ipcMain.invoke('profiles:rename', p.id, '  After  ')
  assert.equal(after.find((x: { id: string }) => x.id === p.id).name, 'After')
  const unchanged = await ipcMain.invoke('profiles:rename', p.id, '   ')
  assert.equal(unchanged.find((x: { id: string }) => x.id === p.id).name, 'After', 'a blank rename changes nothing')
})

test("who a config dir is signed in as, read from the CLI's own files", async () => {
  // Claude: the default sign-in keeps its config in ~/.claude.json, not in the config dir
  const claudeDir = path.join(userHome, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' } }))
  const def = await ipcMain.invoke('profiles:default', 'claude')
  assert.equal(def.signedIn, true)
  assert.equal(def.account, 'me@example.com · Acme')

  // Codex: the account comes out of the id_token in auth.json
  const codexDir = path.join(userHome, '.codex')
  fs.mkdirSync(codexDir, { recursive: true })
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt({ email: 'dev@example.com' }) } }))
  const codex = await ipcMain.invoke('profiles:default', 'codex')
  assert.equal(codex.signedIn, true)
  assert.equal(codex.account, 'dev@example.com')

  // an API key is a sign-in without an email
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }))
  assert.deepEqual(
    await ipcMain.invoke('profiles:default', 'codex').then((r: { signedIn: boolean; account?: string }) => [r.signedIn, r.account]),
    [true, 'API key']
  )

  // a malformed token must not throw: it is simply not an account we can name
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { id_token: 'not-a-jwt' } }))
  const bad = await ipcMain.invoke('profiles:default', 'codex')
  assert.equal(bad.signedIn, true)
  assert.equal(bad.account, undefined)
})

test('an empty profile reads as not signed in, so the UI can say so', async () => {
  const p = await ipcMain.invoke('profiles:create', 'claude', 'Fresh')
  const found = (await ipcMain.invoke('profiles:list', 'claude')).find((x: { id: string }) => x.id === p.id)
  assert.equal(found.signedIn, false)
  assert.equal(found.account, undefined)
  // and only that CLI's profiles come back
  assert.deepEqual(
    (await ipcMain.invoke('profiles:list', 'codex')).filter((x: { agentId: string }) => x.agentId !== 'codex'),
    []
  )
})
