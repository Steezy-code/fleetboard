// A fleet tool's arguments come from a model, and its inputSchema is only advertised, never checked.
// A string where the schema promised a list has a length, so it got past every `?? []` and threw
// where the worker's brief was written, after its console had started: the worker ran unbriefed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FleetMember } from '../../src/shared/fleet'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-args-'))
const { briefFor, coerceArgs, toolSchema } = await import('../../src/main/fleet')

const spawn = toolSchema('fleet_spawn_worker')

test('a lone string where a list was promised becomes a list of one', () => {
  assert.deepEqual(coerceArgs(spawn, { task: 'x', owns: 'src/a.ts', done_when: 'y' }).owns, ['src/a.ts'])
  assert.deepEqual(coerceArgs(toolSchema('fleet_plan'), { tasks: 'one' }).tasks, ['one'])
  assert.deepEqual(coerceArgs(toolSchema('fleet_plan'), { tasks: [{ title: 'Add tests', estimate: 5 }, 'two'] }).tasks, ['Add tests', 'two'])
  assert.deepEqual(coerceArgs(spawn, { owns: ['a', 7] }).owns, ['a', '7'])
})

test('a string field is a string, whatever the model sent', () => {
  assert.equal(coerceArgs(spawn, { task: 5 }).task, '5')
  assert.equal(coerceArgs(toolSchema('fleet_report'), { status: 'done', summary: ['did', 'it'] }).summary, 'did,it')
})

test('a missing or null field stays missing, numbers pass through, and undeclared keys are dropped', () => {
  const a = coerceArgs(spawn, { task: 'x', owns: ['a'], done_when: 'y', name: null, extra: 'z' })
  assert.equal('name' in a, false)
  assert.equal('task_ref' in a, false)
  assert.equal('extra' in a, false)
  assert.equal(coerceArgs(toolSchema('fleet_wait'), { timeout_seconds: 30 }).timeout_seconds, 30)
  assert.deepEqual(coerceArgs(toolSchema('fleet_plan'), { tasks: ['a'], estimates: [5] }).estimates, [5])
})

test('arguments that are not an object at all give nothing rather than a throw', () => {
  for (const raw of [null, undefined, 'owns', 42]) assert.deepEqual(coerceArgs(spawn, raw), {})
  assert.deepEqual(coerceArgs(undefined, { task: 'x' }), {})
})

test('the brief of a worker spawned with a lone string for owns is written, not thrown', () => {
  const a = coerceArgs(spawn, { task: 'Write a.txt', owns: 'a.txt', done_when: 'a.txt exists' })
  const lead: FleetMember = { id: 'lead', name: 'Ada', role: 'lead', agentId: 'claude', projectId: 'p', cwd: '/repo', status: 'working', createdAt: 1 }
  const w: FleetMember = { ...lead, id: 'w', name: 'Bo', role: 'worker', leadId: 'lead', task: a.task as string, owns: a.owns as string[], doneWhen: a.done_when as string }
  assert.match(briefFor(w, lead), /You own: a\.txt\./)
})
