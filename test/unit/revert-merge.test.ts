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
