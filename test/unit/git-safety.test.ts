// A repository's own config can name commands for git to run while it builds a patch: `diff.external`
// replaces git's diff machinery, and a textconv driver (a .gitattributes entry plus a diff.<name>.textconv
// command) is run once per changed file. Here that config is input, not policy: the morning sweep runs
// git in every repository it finds by walking the user's folders, and an agent that may edit files but
// not run commands (a console in acceptEdits, every fleet worker) can write .git/config and
// .gitattributes. Clicking a commit in the git drawer, or reading a team's diff before pressing Merge,
// was enough to run what the repo chose, with the user's full environment and no prompt.
//
// Which subcommand each mechanism reaches is not obvious, and getting it wrong is how the hole stayed
// open: `git show` ignores diff.external unless asked (--ext-diff), so the drawer looked safe, while
// textconv reaches show, log -p and diff alike. git.ts's diff() did pass --no-ext-diff — and was still
// exposed through textconv. So each test plants the config, shows that plain git really runs it, and
// then shows that this app's git() does not. Without the first half the second proves nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-gitsafe-home-'))
const { git, GIT_OPTS } = await import('../../src/main/run')

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

/** A repo with two commits whose config runs a script that leaves a marker, by `how`. */
function hostileRepo(how: 'external' | 'textconv') {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostile-')))
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: ENV })
  const marker = path.join(repo, 'RAN')
  const script = path.join(repo, 'payload.sh')
  sh('init', '-q', '-b', 'main')
  // a textconv driver has to print the file; an external diff just has to exist
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null\nexit 0\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  if (how === 'textconv') fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n')
  sh('add', '-A')
  sh('commit', '-qm', 'first')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  sh('add', '-A')
  sh('commit', '-qm', 'second')
  sh('config', how === 'external' ? 'diff.external' : 'diff.evil.textconv', script)
  const ran = () => fs.existsSync(marker)
  const reset = () => fs.rmSync(marker, { force: true })
  const plain = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: ENV })
  return { repo, ran, reset, plain }
}

test('an external diff driver named by the repo is never run', async () => {
  const { repo, ran, reset, plain } = hostileRepo('external')

  plain('diff', 'HEAD~1')
  assert.equal(ran(), true, 'plain `git diff` runs diff.external — if this fails the rest proves nothing')
  reset()

  // the git drawer's own diff, and the team's Ready diff
  for (const args of [['diff', 'HEAD~1'], ['diff', '--stat', '-p', 'HEAD~1..HEAD'], ['show', '--patch', 'HEAD']]) {
    const r = await git(repo, args)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(ran(), false, `nothing was run by \`git ${args.join(' ')}\``)
  }
  // and the patch is still a real patch, made by git itself
  assert.match((await git(repo, ['diff', 'HEAD~1'])).stdout, /^-one$/m)
})

test('a textconv driver named by the repo is never run — the one that reaches git show', async () => {
  const { repo, ran, reset, plain } = hostileRepo('textconv')

  plain('show', 'HEAD')
  assert.equal(ran(), true, 'plain `git show` runs a textconv driver — this is what --no-ext-diff alone misses')
  reset()

  for (const args of [['show', '--no-color', '--stat', '--patch', 'HEAD'], ['log', '-p', '-1'], ['diff', 'HEAD~1'], ['diff', '--cached']]) {
    const r = await git(repo, args)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(ran(), false, `nothing was run by \`git ${args.join(' ')}\``)
  }
  assert.match((await git(repo, ['show', '--patch', 'HEAD'])).stdout, /\+two/, 'and the patch is still there')
})

test('git is told to ignore a filesystem monitor the repo names', async () => {
  // Defence in depth, stated honestly: core.fsmonitor names a program and `git status` is the app's
  // most-run command, but a hostile core.fsmonitor did not reproduce on the git here (2.43), so this
  // asserts the argument rather than an outcome it cannot demonstrate.
  assert.deepEqual(GIT_OPTS, ['-c', 'core.fsmonitor=false'])
  const { repo } = hostileRepo('external')
  execFileSync('git', ['config', 'core.fsmonitor', path.join(repo, 'payload.sh')], { cwd: repo, env: ENV })
  const r = await git(repo, ['status', '--porcelain=v2', '--branch'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(fs.existsSync(path.join(repo, 'RAN')), false)
})

test('run.ts is the only module that names git as a program to run', () => {
  const MAIN = path.join(import.meta.dirname, '..', '..', 'src', 'main')
  const spawners = fs
    .readdirSync(MAIN)
    .filter((n) => n.endsWith('.ts') && n !== 'run.ts')
    .filter((n) => /(execFile|execFileSync|spawn|spawnSync)\(\s*'git'/.test(fs.readFileSync(path.join(MAIN, n), 'utf8')))
    .sort()
  assert.deepEqual(spawners, [], 'run git through git() from run.ts: it is where the environment and the arguments are made safe')
})
