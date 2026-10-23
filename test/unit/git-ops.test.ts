// The Git card's status and commit, through the real IPC handlers, with file names people really have.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ipcMain } from '../support/electron-stub'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-git-'))
const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true })
  fs.writeFileSync(path.join(repo, f), c)
}
// Windows can't have " * or a newline in a file name
const WIN = process.platform === 'win32'
/** a name with a glob character that also matches another file (file[1] matches file1, star* matches stars) */
const GLOBBY = WIN ? 'file[1].txt' : 'star*.txt'
const GLOB_MATCH = WIN ? 'file1.txt' : 'stars.txt'
const WEIRD = ['app/[id]/page.tsx', 'docs/my notes.md', 'src/ünïcødé.ts', "it's.txt", '-dash.txt', GLOBBY, ...(WIN ? ['brace{1}.txt', 'semi;colon.txt'] : ['quote"d.txt', 'new\nline.txt'])]

before(async () => {
  process.env.SHELL = '/bin/false'
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t'
  sh('init', '-q')
  for (const f of [...WEIRD, 'app/i/page.tsx', 'old name.txt']) write(f, 'v1\n')
  sh('add', '-A')
  sh('commit', '-qm', 'init')
  // the open project, as the app declares it: git runs only inside the folders Fleetboard may use
  ;(await import('../../src/main/roots')).declareProject(repo)
  const git = await import('../../src/main/git')
  git.register({ ipc: ipcMain as any, win: () => null, ptys: null as any, settings: () => ({}) as any, emit: () => {} })
})

test('a repo outside the folders Fleetboard may use is refused, whatever the board file says', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-git-other-'))
  execFileSync('git', ['init', '-q'], { cwd: other })
  assert.equal(await ipcMain.invoke('git:isRepo', other), false)
  const r = await ipcMain.invoke('git:status', other)
  assert.equal(r.ok, false)
  const push = await ipcMain.invoke('git:push', other)
  assert.equal(push.ok, false)
})

test('status reads every odd file name exactly', async () => {
  for (const f of WEIRD) write(f, 'v2\n')
  sh('mv', 'old name.txt', 'new name.txt')
  const r = await ipcMain.invoke('git:status', repo)
  assert.equal(r.ok, true, JSON.stringify(r))
  const paths = r.status.files.map((f: any) => f.path).sort()
  assert.deepEqual(paths, [...WEIRD, 'new name.txt'].sort())
  const renamed = r.status.files.find((f: any) => f.path === 'new name.txt')
  assert.equal(renamed.from, 'old name.txt')
})

test('committing selected files commits and stages exactly those, glob characters and all', async () => {
  fs.rmSync(path.join(repo, 'app/[id]/page.tsx'))
  write('app/i/page.tsx', 'not selected\n')
  const pick = ['app/[id]/page.tsx', GLOBBY, ...(WIN ? [] : ['new\nline.txt']), '-dash.txt']
  const r = await ipcMain.invoke('git:commit', repo, 'pick a few', pick.map((p) => ({ path: p })))
  assert.equal(r.ok, true, JSON.stringify(r))
  const committed = sh('show', '--name-only', '-z', '--format=', 'HEAD').split('\0').filter(Boolean).sort()
  assert.deepEqual(committed, [...pick].sort())
  const staged = sh('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean)
  assert.ok(!staged.includes('app/i/page.tsx'), 'nothing else was staged behind the user\'s back (app/i/page.tsx matches the glob app/[id])')
})

test('a selected rename commits both sides', async () => {
  const r = await ipcMain.invoke('git:commit', repo, 'rename', [{ path: 'new name.txt', from: 'old name.txt' }])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(sh('show', '--name-status', '--format=', '-M', 'HEAD'), /^R\d*\told name\.txt\tnew name\.txt$/m)
})

test('the diff of a file with glob characters is that file only', async () => {
  write('app/i/page.tsx', 'changed again\n')
  write(GLOBBY, 'v3\n')
  write(GLOB_MATCH, 'other\n')
  sh('add', GLOB_MATCH)
  sh('commit', '-qm', 'stars')
  write(GLOB_MATCH, 'other changed\n')
  const r = await ipcMain.invoke('git:diff', repo, GLOBBY, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.diff, /\+v3/)
  assert.doesNotMatch(r.diff, /other changed/)
})

test('a checkout of a name that is also a path is refused, not a silent revert', async () => {
  // `git checkout .` and `git checkout src` take the name as a pathspec and throw away the
  // uncommitted work there. The Git card's branch list is the usual caller, but the name arrives
  // over IPC, so the branch has to be unambiguous.
  write('app/i/page.tsx', 'work in progress\n')
  const before = await ipcMain.invoke('git:status', repo)
  assert.ok(
    before.status.files.some((f: any) => f.path === 'app/i/page.tsx'),
    'the file starts out modified'
  )
  for (const name of ['.', 'app', 'app/i/page.tsx']) {
    const r = await ipcMain.invoke('git:checkout', repo, name)
    assert.equal(r.ok, false, `checkout ${name} must fail`)
  }
  const after = await ipcMain.invoke('git:status', repo)
  assert.ok(
    after.status.files.some((f: any) => f.path === 'app/i/page.tsx'),
    'the uncommitted work is still there'
  )
})

test('a real branch, and a commit id, still check out', async () => {
  sh('add', '-A')
  sh('commit', '-qm', 'wip')
  const head = sh('rev-parse', 'HEAD').trim()
  assert.equal((await ipcMain.invoke('git:checkout', repo, 'side', true)).ok, true, 'create a branch')
  assert.equal(sh('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'side')
  const first = sh('rev-list', '--max-parents=0', 'HEAD').trim()
  assert.equal((await ipcMain.invoke('git:checkout', repo, first)).ok, true, 'a commit id (detached, as remote branches use)')
  assert.equal(sh('rev-parse', 'HEAD').trim(), first)
  assert.equal((await ipcMain.invoke('git:checkout', repo, 'side')).ok, true, 'back to the branch')
  assert.equal(sh('rev-parse', 'HEAD').trim(), head)
})

test('committing everything is held to the list that was on screen', async () => {
  write('held.txt', 'v1\n')
  const st = await ipcMain.invoke('git:status', repo)
  const shown = st.status.files.map((f: any) => f.path)
  const head = sh('rev-parse', 'HEAD').trim()
  // an agent writes another file between the look and the click
  write('.env.local', 'SECRET=1\n')
  const r = await ipcMain.invoke('git:commit', repo, 'all of it', null, shown)
  assert.equal(r.ok, false)
  assert.match(r.error, /\.env\.local changed since you looked/)
  assert.equal(sh('rev-parse', 'HEAD').trim(), head, 'nothing was committed')
  fs.rmSync(path.join(repo, '.env.local'))
  const ok = await ipcMain.invoke('git:commit', repo, 'all of it', null, shown)
  assert.equal(ok.ok, true, JSON.stringify(ok))
})
