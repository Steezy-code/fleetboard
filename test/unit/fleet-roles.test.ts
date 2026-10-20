// A team console reaches the fleet tools over MCP with its own bearer token. `tools/list` decides
// only what a member is *told* about, so the role has to be enforced where a tool is actually run:
// without that, a worker — anything able to prompt-inject a worker through a file, issue, dependency
// or PR comment it reads — could call fleet_finish and put its own unreviewed branch on the user's
// Ready card, fleet_dismiss a sibling's unmerged work, or fleet_ask_user to phish an approval.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-roles-'))
const { toolDenial, toolRoles } = await import('../../src/main/fleet')

/** Every tool a role is allowed to call, straight from the catalogue the server advertises. */
const LEAD_ONLY = [
  'fleet_plan',
  'fleet_update_task',
  'fleet_spawn_worker',
  'fleet_spawn_reviewer',
  'fleet_wait',
  'fleet_merge',
  'fleet_dismiss',
  'fleet_ask_user',
  'fleet_finish'
]
const SHARED = ['fleet_send', 'fleet_status']
const CREW_ONLY = ['fleet_report']

test('a worker may not call the lead-only tools', () => {
  for (const name of LEAD_ONLY) {
    const denied = toolDenial(name, 'worker')
    assert.ok(denied, `${name} must be refused for a worker`)
    assert.match(denied, /you are a worker/)
    // the refusal tells the model what it *can* use, so it keeps working instead of flailing
    assert.match(denied, /fleet_report/)
  }
})

test('a reviewer may not call the lead-only tools either', () => {
  // a reviewer is launched with its edit tools removed; the fleet surface must not hand them back
  for (const name of LEAD_ONLY) assert.ok(toolDenial(name, 'reviewer'), `${name} must be refused for a reviewer`)
})

test('a lead keeps every lead tool, and the shared ones', () => {
  for (const name of [...LEAD_ONLY, ...SHARED]) assert.equal(toolDenial(name, 'lead'), null, name)
})

test('crew report, leads do not; the shared tools are open to all three', () => {
  for (const name of CREW_ONLY) {
    assert.equal(toolDenial(name, 'worker'), null, name)
    assert.equal(toolDenial(name, 'reviewer'), null, name)
    assert.ok(toolDenial(name, 'lead'), `${name} is not a lead tool`)
  }
  for (const name of SHARED) for (const role of ['lead', 'worker', 'reviewer'] as const) assert.equal(toolDenial(name, role), null, `${name}/${role}`)
})

test('an unknown tool name is refused for every role', () => {
  for (const role of ['lead', 'worker', 'reviewer'] as const) {
    assert.match(String(toolDenial('fleet_merge_everything', role)), /Unknown tool/)
    assert.match(String(toolDenial('', role)), /Unknown tool/)
    // not reachable through the switch, but a name must never be allowed by accident
    assert.match(String(toolDenial('__proto__', role)), /Unknown tool/)
  }
  assert.equal(toolRoles('fleet_merge_everything'), null)
})

test('every tool in the catalogue names at least one role', () => {
  for (const name of [...LEAD_ONLY, ...SHARED, ...CREW_ONLY]) {
    const roles = toolRoles(name)
    assert.ok(roles && roles.length, `${name} is in the catalogue`)
  }
})

test('callTool enforces the role before it runs anything', () => {
  // toolDenial is only worth having if callTool actually consults it: a refactor that drops the
  // guard would leave every test above passing while the hole is wide open again.
  const src = fs.readFileSync(new URL('../../src/main/fleet.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async function callTool('))
  const guard = body.indexOf('toolDenial(name, m.role)')
  const firstCase = body.indexOf("case 'fleet_")
  assert.ok(guard > 0, 'callTool must consult toolDenial')
  assert.ok(firstCase > 0 && guard < firstCase, 'the role check must come before the first tool runs')
})
