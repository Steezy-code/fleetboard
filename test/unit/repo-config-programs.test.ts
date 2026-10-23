// The morning sweep runs git in repos the user never opened. Before it does, it reads the repo's own
// config — which runs nothing — for keys that name a program git would run, and leaves such a repo
// alone. This only writes config values and reads them back; no git command that would use them runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SHELL = '/bin/false'
const { programsInRepoConfig } = await import('../../src/main/run')

function repo(config: [string, string][]) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'))
  execFileSync('git', ['init', '-q'], { cwd: d })
  for (const [k, v] of config) execFileSync('git', ['config', '--local', k, v], { cwd: d })
  return d
}

test('a plain repo, or one with the usual tools, names nothing to refuse', async () => {
  assert.deepEqual(await programsInRepoConfig(repo([])), [])
  const usual = repo([
    ['filter.lfs.clean', 'git-lfs clean -- %f'],
    ['filter.lfs.process', 'git-lfs filter-process'],
    ['filter.git-crypt.smudge', '"git-crypt" smudge'],
    // husky's: the sweep points hooks at an empty folder, so this is not a reason to skip
    ['core.hooksPath', '.husky/_'],
    ['user.name', 'someone']
  ])
  assert.deepEqual(await programsInRepoConfig(usual), [])
})

test('a filter, credential helper, ssh command or protocol override of the repo’s own is reported', async () => {
  const d = repo([
    ['filter.x.clean', 'some-program'],
    ['credential.helper', 'some-helper'],
    ['core.sshCommand', 'some-ssh'],
    ['protocol.ext.allow', 'always'],
    ['remote.origin.uploadpack', 'some-upload-pack']
  ])
  assert.deepEqual((await programsInRepoConfig(d)).sort(), ['core.sshcommand', 'credential.helper', 'filter.x.clean', 'protocol.ext.allow', 'remote.origin.uploadpack'])
})

test('a key in a file the repo config includes counts too', async () => {
  const d = repo([])
  const extra = path.join(d, 'extra.gitconfig')
  fs.writeFileSync(extra, '[filter "y"]\n\tsmudge = some-program\n')
  execFileSync('git', ['config', '--local', 'include.path', extra], { cwd: d })
  assert.deepEqual(await programsInRepoConfig(d), ['filter.y.smudge'])
})
