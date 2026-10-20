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
  const git = await import('../../src/main/git')
  git.register({ ipc: ipcMain as any, win: () => null, ptys: null as any, settings: () => ({}) as any, emit: () => {} })
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
