// The board's spoken-command vocabulary is written out in three places with no compiler link between
// them: the Action union (what the app can do), coerceAction's switch (what it will accept from a
// model) and ACTION_SCHEMA (what the model is told it may say, as prose in a prompt). Adding a
// seventeenth action means editing all three, and missing one fails quietly in a different way each
// time: miss the schema and the model never emits it; miss the switch and coerceAction returns null
// and the command is silently dropped.
//
// Reading the source rather than the behaviour is the point — it catches the next action, not this
// one (docs/ARCHITECTURE.md, "Invariant tests").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'voice')
const actions = fs.readFileSync(path.join(SRC, 'actions.ts'), 'utf8')
const planner = fs.readFileSync(path.join(SRC, 'planner.ts'), 'utf8')

/** The `type` of every variant of the Action union. */
const union = (() => {
  const body = /export type Action =\n((?:\s*\|[^\n]*\n)+)/.exec(actions)?.[1]
  assert.ok(body, 'the Action union is still written as a list of | variants')
  return [...body.matchAll(/\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]!)
})()

test('the union is read correctly, so the tests below are not vacuous', () => {
  assert.ok(union.length >= 16, `expected the whole vocabulary, found ${union.length}: ${union}`)
  assert.ok(union.includes('spawn') && union.includes('say'))
  assert.equal(new Set(union).size, union.length, 'no duplicates')
})

test('every action the app can do is one coerceAction will accept', () => {
  const switchBody = actions.slice(actions.indexOf('export function coerceAction'))
  const handled = new Set([...switchBody.matchAll(/case '([^']+)':/g)].map((m) => m[1]!))
  assert.deepEqual(
    union.filter((t) => !handled.has(t)),
    [],
    "add a case to coerceAction's switch, or the model's reply is dropped and nothing says why"
  )
})

test('every action the app can do is one the model is told it may say', () => {
  assert.deepEqual(
    union.filter((t) => !new RegExp(`"type"\\s*:\\s*"${t}"`).test(planner)),
    [],
    'add it to ACTION_SCHEMA in planner.ts, or the model will never emit it'
  )
})
