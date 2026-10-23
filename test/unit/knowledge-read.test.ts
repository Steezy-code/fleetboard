// The free half of repo knowledge: what the main process reads from a repo's own files, with no model
// and no shell. Everything it finds is `repo` provenance, so it has to be things the files really say.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-know-'))
process.env.FLEETBOARD_HOME = home

let readRepo: typeof import('../../src/main/knowledge').readRepo

const repo = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-know-repo-'))
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
    fs.writeFileSync(path.join(dir, p), body)
  }
  return dir
}
const byKey = (r: { facts: { key: string }[] }) => Object.fromEntries(r.facts.map((f) => [f.key, f])) as Record<string, any>

before(async () => {
  ;({ readRepo } = await import('../../src/main/knowledge'))
})

test('how a pnpm repo checks itself, who owns what and its style, all read from the files', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'oxlint', 'test:e2e': 'playwright test', dev: 'vite', 'typecheck:strict': 'tsc -p strict' } }),
    'pnpm-lock.yaml': '',
    'test/a.test.ts': '',
    '.github/CODEOWNERS': '# owners\n/src/main/  @luke\n*.css @design-team @ann\n\n',
    '.github/workflows/ci.yml': 'name: ci\n',
    '.github/workflows/release.yaml': 'name: release\n',
    '.editorconfig': 'root = true\n[*]\nindent_style = space\nindent_size = 2\n',
    '.prettierrc': '{}',
    'tsconfig.json': '{ // comment\n "compilerOptions": { "strict": true } }',
    'CLAUDE.md': '# rules\n',
    'README.md': '# demo\n'
  })
  const r = readRepo(dir, 5)
  const f = byKey(r)
  assert.equal(f['checks.package-manager']?.text, 'Packages are managed with pnpm')
  assert.equal(f['checks.test']?.command, 'pnpm test')
  assert.equal(f['checks.lint']?.command, 'pnpm run lint')
  assert.equal(f['checks.test-e2e']?.command, 'pnpm run test:e2e')
  assert.equal(f['checks.typecheck-strict']?.command, 'pnpm run typecheck:strict')
  assert.equal(f['checks.dev'], undefined, 'a dev server is not a check')
  assert.match(f['checks.ci']?.text, /GitHub Actions.*ci\.yml.*release\.yaml/)
  assert.equal(f['layout.tests']?.text, 'Tests live in test/')
  assert.equal(f['ownership.src-main']?.text, 'src/main/ is owned by @luke')
  assert.equal(f['ownership.css']?.text, '*.css is owned by @design-team, @ann')
  assert.equal(f['ownership.src-main']?.source, '.github/CODEOWNERS')
  assert.match(f['style.indent']?.text, /2 spaces/)
  assert.ok(f['style.prettier'])
  assert.ok(f['style.typescript-strict'])
  assert.equal(f['style.guide-claude-md']?.source, 'CLAUDE.md')
  for (const x of r.facts) {
    assert.equal(x.provenance, 'repo')
    assert.equal(x.at, 5)
    // Review Focus 7: compared later against paths the charter and merge gate use
    assert.ok(!x.source?.includes('\\'), `${x.key}: ${x.source}`)
  }
  assert.deepEqual(r.docs, ['README.md', 'CLAUDE.md'])
})

test('npm, make, cargo, go and pytest each say their own command', () => {
  const f = byKey(readRepo(repo({ 'package.json': '{"scripts":{"test":"jest","build":"tsc"}}', 'package-lock.json': '{}', Makefile: 'test:\n\tgo test\nlint: deps\n\tx\n.PHONY: test\n' })))
  assert.equal(f['checks.test']?.command, 'npm test')
  assert.equal(f['checks.build']?.command, 'npm run build')
  assert.equal(f['checks.make-test']?.command, 'make test')
  assert.equal(f['checks.make-lint']?.command, 'make lint')
  assert.equal(byKey(readRepo(repo({ 'Cargo.toml': '[package]\n' })))['checks.cargo-test']?.command, 'cargo test')
  assert.equal(byKey(readRepo(repo({ 'go.mod': 'module x\n' })))['checks.go-test']?.command, 'go test ./...')
  assert.equal(byKey(readRepo(repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })))['checks.pytest']?.command, 'pytest')
})

test('an empty folder, or one whose files are broken, is no facts and no error', () => {
  assert.deepEqual(readRepo(repo({})), { facts: [], docs: [] })
  const r = readRepo(repo({ 'package.json': '{ not json', '.editorconfig': '\u0000\u0001', CODEOWNERS: '' }))
  assert.deepEqual(r.facts, [])
  assert.deepEqual(readRepo(path.join(home, 'no such folder')), { facts: [], docs: [] })
})

test('the read is offered only for a folder Fleetboard may read', async () => {
  const store = await import('../../src/main/store')
  const knowledge = await import('../../src/main/knowledge')
  const { DEFAULT_SETTINGS } = await import('../../src/shared/types')
  const ctx = { ipc: ipcMain as never, win: () => null, ptys: null as never, settings: () => DEFAULT_SETTINGS, emit: () => {} }
  store.register(ctx)
  knowledge.register(ctx)
  const inside = repo({ 'package.json': '{"scripts":{"test":"x"}}' })
  const outside = repo({ 'package.json': '{"scripts":{"test":"x"}}' })
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true })
  const board = { schema: 1, id: 'kp', name: 'p', path: inside, activeWorkspaceId: 'w', lastOpened: 1, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] }
  fs.writeFileSync(path.join(home, 'projects', 'kp.json'), JSON.stringify(board))
  assert.ok(store.loadProject('kp'))
  assert.equal((await ipcMain.invoke('knowledge:read', inside))?.facts[0]?.command, 'npm test')
  assert.equal(await ipcMain.invoke('knowledge:read', outside), null)
  assert.equal(await ipcMain.invoke('knowledge:read', 42), null)
})

test('an .editorconfig value padded to its size limit is read in linear time', () => {
  const t = Date.now()
  const r = readRepo(repo({ '.editorconfig': `[*]\nindent_style = space${' '.repeat(250_000)}x\nindent_size = 4\n` }))
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`)
  assert.ok(r)
})
