// A Gemini CLI home for team consoles: the user's ~/.gemini linked in, settings with the fleet server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-gemhome-'))
process.env.FLEETBOARD_HOME = path.join(tmp, 'fb')
const { geminiTeamHome, geminiTrusts, parseJsonc, removeGeminiTeamHome } = await import('../../src/main/gemini-home')

const home = path.join(tmp, 'home')
const real = path.join(home, '.gemini')
fs.mkdirSync(path.join(real, 'tmp', 'proj', 'chats'), { recursive: true })
fs.writeFileSync(path.join(real, 'oauth_creds.json'), '{"token":"x"}')
fs.writeFileSync(path.join(real, 'trustedFolders.json'), JSON.stringify({ '/work/repo': 'TRUST_FOLDER', '/work/other/sub': 'TRUST_PARENT', '/work/repo/vendor': 'DO_NOT_TRUST' }))
fs.writeFileSync(
  path.join(real, 'settings.json'),
  `{
  // the user's own settings, with comments as Gemini allows
  "security": { "auth": { "selectedType": "oauth-personal" } },
  "general": { "vimMode": true, "note": "a // inside a string stays" },
  "mcpServers": { "theirs": { "command": "their-server" }, },
}`
)

test('parseJsonc reads comments and trailing commas, not comment-like text in strings', () => {
  assert.deepEqual(parseJsonc('{ /* a */ "a": "x//y", // b\n "b": [1, 2,], }'), { a: 'x//y', b: [1, 2] })
  assert.equal(parseJsonc('{ nope'), null)
})

test("a team console's home: the user's files linked in, their settings plus the fleet server", () => {
  const h = geminiTeamHome('con_ada', { url: 'http://127.0.0.1:5000/mcp/con_ada', token: 'secret-token' }, { HOME: home })
  const dot = path.join(h, '.gemini')
  assert.equal(fs.readlinkSync(path.join(dot, 'oauth_creds.json')), path.join(real, 'oauth_creds.json'), 'signed in as the user is')
  assert.equal(fs.readlinkSync(path.join(dot, 'tmp')), path.join(real, 'tmp'), 'sessions where the app looks for them')
  const settings = JSON.parse(fs.readFileSync(path.join(dot, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.security, { auth: { selectedType: 'oauth-personal' } })
  assert.equal(settings.general.note, 'a // inside a string stays')
  assert.deepEqual(settings.mcpServers.theirs, { command: 'their-server' }, "the user's servers are kept")
  assert.deepEqual(settings.mcpServers.fleet, { httpUrl: 'http://127.0.0.1:5000/mcp/con_ada', headers: { Authorization: 'Bearer secret-token' }, trust: true, timeout: 600000 })
  assert.equal(fs.statSync(path.join(dot, 'settings.json')).mode & 0o077, 0, 'the token is readable by the user only')
  assert.ok(!fs.readFileSync(path.join(real, 'settings.json'), 'utf8').includes('fleet'), "the user's own settings are untouched")
  // again (a restart): same home, no errors
  assert.equal(geminiTeamHome('con_ada', { url: 'u', token: 't' }, { HOME: home }), h)
  removeGeminiTeamHome('con_ada')
  assert.equal(fs.existsSync(h), false)
  assert.ok(fs.existsSync(path.join(real, 'oauth_creds.json')), 'removing it leaves the real files alone')
})

test('without any Gemini setup yet, the home holds just the fleet server', () => {
  const h = geminiTeamHome('con_new', { url: 'u', token: 't' }, { HOME: path.join(tmp, 'fresh') })
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers), ['fleet'])
})

test('geminiTrusts follows trustedFolders.json: folders, parents, the closest rule wins', () => {
  const env = { HOME: home }
  assert.equal(geminiTrusts('/work/repo', env), true)
  assert.equal(geminiTrusts('/work/repo/src', env), true)
  assert.equal(geminiTrusts('/work/repo/vendor/lib', env), false, 'a closer DO_NOT_TRUST wins')
  assert.equal(geminiTrusts('/work/other/elsewhere', env), true, 'TRUST_PARENT trusts the parent')
  assert.equal(geminiTrusts('/work/repository', env), false, 'a prefix of the name is not a parent')
  assert.equal(geminiTrusts('/elsewhere', env), false)
  assert.equal(geminiTrusts('/work/repo', { HOME: path.join(tmp, 'fresh') }), false)
})
