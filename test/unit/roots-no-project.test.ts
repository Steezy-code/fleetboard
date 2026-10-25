// The roots with no board open. Its own file because each test file is its own process: once a
// project has been loaded there is no way back to "nothing open", and that is the state the app is in
// for the first moments of every launch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-roots-none-'))
process.env.FLEETBOARD_HOME = home
const roots = await import('../../src/main/roots')

test('with no board open, only ~/.fleetboard is allowed', () => {
  assert.equal(roots.insideAllowed(path.join(home, 'assets', 'pic.png')), true)
  assert.equal(roots.insideAllowed(home), true)
  assert.deepEqual(roots.allowedRoots(), [home], 'the project root is not in the list yet')
  for (const p of ['/etc/passwd', path.join(os.homedir(), 'code', 'anything'), os.tmpdir()]) {
    assert.equal(roots.insideAllowed(p), false, p)
  }
})

test('a relative path has nothing to resolve against, so it is refused rather than guessed', () => {
  // resolving against the main process cwd would silently point at the repo Fleetboard runs from
  assert.equal(roots.absolutePath('src/app.ts'), null)
  assert.equal(roots.insideAllowed('src/app.ts'), false)
})

test('the renderer cannot declare a folder too broad to be a project', () => {
  // store:projectId is renderer-callable with any path, so this is the one amplification worth
  // closing: declaring / or the home folder would allow everything underneath in a single call
  for (const wide of ['/', path.parse(process.cwd()).root, os.homedir(), path.dirname(os.homedir())]) {
    roots.declareProject(wide)
    assert.equal(roots.projectRoot(), null, wide)
    assert.equal(roots.insideAllowed(path.join(os.homedir(), '.ssh', 'id_ed25519')), false, wide)
  }
  // a folder inside home is a project like any other
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-declared-'))
  roots.declareProject(real)
  assert.equal(roots.projectRoot(), real)
})

test('a folder the user picked in a dialog is theirs to pick, home folder included', () => {
  // the dotfiles-repo-at-~ case: refused when a file claims it, allowed when the user says so
  roots.resetGrantsForTest()
  assert.equal(roots.insideAllowed(path.join(os.homedir(), '.bashrc')), false)
  roots.grant(os.homedir())
  assert.equal(roots.insideAllowed(path.join(os.homedir(), '.bashrc')), true)
  roots.resetGrantsForTest()
})
