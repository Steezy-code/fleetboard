import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson } from '@/lib/api'

test('plain object', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

test('fenced json with prose around it', () => {
  assert.deepEqual(extractJson('Sure! Here is the plan:\n```json\n{"actions":[{"type":"zoom"}]}\n```\nLet me know.'), { actions: [{ type: 'zoom' }] })
})

test('unfenced object followed by prose with braces', () => {
  assert.deepEqual(extractJson('{"say":"ok"} and then {not json}'), { say: 'ok' })
})

test('array', () => {
  assert.deepEqual(extractJson('facts: [1, 2, 3]'), [1, 2, 3])
})

test('no json', () => {
  assert.equal(extractJson('nothing here'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson('{ broken'), null)
})

test('braces inside strings', () => {
  assert.deepEqual(extractJson('{"say":"use {x} and }"}'), { say: 'use {x} and }' })
})

test('JSON after a bracket in the prose is still found, and a long reply is quick', async () => {
  const { extractJson } = await import('@/lib/api')
  assert.deepEqual(extractJson('As noted in [1], here it is: {"ok": true, "s": "a } in a string"}'), { ok: true, s: 'a } in a string' })
  const long = 'x }'.repeat(50_000) + ' {"n": 1}'
  const t = Date.now()
  assert.deepEqual(extractJson(long), { n: 1 })
  assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`)
})
