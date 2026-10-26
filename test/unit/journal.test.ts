// A night of unattended work used to leave no trace: loops type into consoles, the CI watcher spawns a
// fixer, a team removes worktrees, and the phone can answer an agent's question — all reported through
// toasts that live 4200 ms. These are the properties the record has to have to be worth keeping: it
// survives a rotation, it survives a torn line, it cannot be grown without bound by what it records,
// and it never throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-journal-'))
process.env.FLEETBOARD_HOME = home
const { append, read } = await import('../../src/main/journal')
const DIR = path.join(home, 'journal')
const today = () => fs.readdirSync(DIR).filter((n) => n.endsWith('.jsonl'))[0]!

test('an entry is one line, and comes back newest first', () => {
  append({ kind: 'loop.fire', text: 'Loop “nightly” sent its instruction to 2 consoles', project: '/tmp/p' })
  append({ kind: 'prompt.answer', text: 'your phone answered "yes"', detail: { consoleId: 'con_1', by: 'your phone' } })
  const all = read()
  assert.equal(all.length, 2)
  assert.equal(all[0]!.kind, 'prompt.answer', 'newest first: this is read at 7am, from the top')
  assert.equal(all[1]!.text, 'Loop “nightly” sent its instruction to 2 consoles')
  assert.deepEqual(all[0]!.detail, { consoleId: 'con_1', by: 'your phone' })
  assert.ok(all[0]!.at >= all[1]!.at)
  assert.equal(fs.readFileSync(path.join(DIR, today()), 'utf8').trim().split('\n').length, 2, 'one line each')
})

test('a line torn by a crash mid-append does not take the day with it', () => {
  const file = path.join(DIR, today())
  fs.appendFileSync(file, '{"at":1,"kind":"console.exit","te')
  append({ kind: 'console.start', text: 'claude started in /tmp/p' })
  const all = read()
  assert.equal(all[0]!.text, 'claude started in /tmp/p', 'the entries after it are still read')
  assert.equal(all.length, 3, 'and the torn one is skipped, not guessed at')
  assert.ok(
    fs.readFileSync(file, 'utf8').endsWith('\n'),
    'and the file is left in a state the next append can add to'
  )
})

test('what it records cannot make it grow without bound', () => {
  append({ kind: 'x'.repeat(500), text: 'y'.repeat(5000), detail: { big: 'z'.repeat(5000) } })
  const e = read()[0]!
  assert.equal(e.kind.length, 60)
  assert.equal(e.text.length, 500)
  assert.equal(e.detail, undefined, 'an oversized detail is dropped rather than truncated into nonsense')
  // a model's multi-line output stays one line
  append({ kind: 'loop.goal', text: 'MET\n\nthe tests pass\tnow' })
  assert.equal(read()[0]!.text, 'MET the tests pass now')
})

test('nowhere to write is not a reason to stop whatever was being recorded', () => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.writeFileSync(DIR, 'not a directory')
  assert.doesNotThrow(() => append({ kind: 'loop.fire', text: 'still running' }))
  assert.deepEqual(read(), [], 'and reading it back is empty rather than a throw')
  fs.rmSync(DIR)
})

test('a busy day rotates more than once and keeps every part, newest first', async () => {
  const { append, read } = await import('../../src/main/journal')
  const big = 'x'.repeat(480)
  // well past two rotations of 2 MB each
  for (let i = 0; i < 10_000; i++) append({ kind: 'test.bulk', text: `${i} ${big}` })
  const all = read({ days: 1, limit: 5000 })
  assert.equal(all.length, 5000)
  assert.match(all[0]!.text, /^9999 /, 'the newest first')
  assert.ok(all.every((e, i) => i === 0 || Number(e.text.split(' ')[0]) < Number(all[i - 1]!.text.split(' ')[0])), 'in order across the parts')
})

test('a detail that cannot be written as JSON costs the detail, not the entry', async () => {
  const { append, read } = await import('../../src/main/journal')
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => append({ kind: 'test.cycle', text: 'still here', detail: cyclic }))
  assert.doesNotThrow(() => append({ kind: 'test.big', text: 'and here', detail: { n: 1n } as never }))
  const texts = read({ days: 1 }).map((e) => e.text)
  assert.ok(texts.includes('still here') && texts.includes('and here'))
})
