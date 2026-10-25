// A team's state file is read at startup. One that is valid JSON but not a team (hand-edited, an older
// shape, cut short) used to throw inside fleet.register — and the app then ran on with no window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-fleetload-'))
const { validFleetState } = await import('../../src/main/fleet')
const { emptyFleet } = await import('../../src/shared/fleet')

test('a team with members loads', () => {
  const s = emptyFleet('p', '/repo')
  s.members = { lead: { id: 'lead', name: 'Lead', role: 'lead', agentId: 'claude', projectId: 'p', cwd: '/repo', status: 'working', createdAt: 0 } }
  assert.equal(validFleetState(s), true)
  assert.equal(validFleetState(emptyFleet('p', '/repo')), true, 'and one with none yet')
})

test('what is not a team is refused rather than trusted', () => {
  for (const bad of [null, 1, 'x', [], {}, { projectId: 'p' }, { projectId: '', members: {} }, { projectId: 'p', members: [] }, { projectId: 'p', members: { a: null } }, { projectId: 'p', members: { a: { id: 'a' } } }, { projectId: 'p', members: {}, tasks: 'no' }])
    assert.equal(validFleetState(bad), false, JSON.stringify(bad))
})
