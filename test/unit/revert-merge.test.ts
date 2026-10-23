// Undoing a merge takes a commit id from the renderer and hands it to git. Anything that is not a
// plain sha has to stop here: `--no-commit` would leave the revert staged and unexplained, a `a..b`
// range would revert a span nobody asked about, and a path would make git read a file as a commit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-revert-'))
const { revertMerge } = await import('../../src/main/fleet')

const NOT_A_SHA = [
  '--no-commit',
  '-n',
  '--no-edit --strategy=ours',
  'HEAD~3',
  'abc123..def456',
  'main',
  '../../etc/passwd',
  'deadbee; rm -rf /',
  'DEADBEEF', // git takes lowercase; uppercase is not what rev-parse handed us
  'deadbe', // six, below the shortest unambiguous prefix git prints
  'g'.repeat(40),
  '',
  '0123456789abcdef0123456789abcdef012345678' // 41
]

test('only a plain hex sha reaches git', async () => {
  for (const bad of NOT_A_SHA) {
    const r = await revertMerge('no-such-project', bad)
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`)
    assert.equal(r.error, 'That is not a commit id.', `wrong refusal for ${JSON.stringify(bad)}`)
  }
})

test('a well-formed sha gets past the shape check and is refused on the project instead', async () => {
  // proves the shape check is not what rejects a real sha — the next guard is
  for (const ok of ['0123456', 'a'.repeat(40), '9f8e7d6c5b4a']) {
    const r = await revertMerge('no-such-project', ok)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'That project is not open.', `shape check rejected ${ok}`)
  }
})

test('a merge finds the ignored files of the user’s it would overwrite (a real .env under a template)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { ignoredInTheWay } = await import('../../src/main/fleet')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ignored-'))
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  sh('init', '-q')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nlocal/\n')
  fs.writeFileSync(path.join(repo, 'readme.md'), 'x\n')
  sh('add', '-A')
  sh('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=real\n')
  fs.mkdirSync(path.join(repo, 'local'))
  fs.writeFileSync(path.join(repo, 'local', 'notes.txt'), 'mine\n')
  const incoming = ['.env', 'local/notes.txt', 'readme.md', 'src/new.ts']
  assert.deepEqual((await ignoredInTheWay(repo, incoming)).sort(), ['.env', 'local/notes.txt'], 'tracked, and not here yet, are not in the way')
  assert.deepEqual(await ignoredInTheWay(repo, ['readme.md', 'src/new.ts']), [])
})
