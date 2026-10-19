// Linking workers to the Lead's plan tasks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTask, guessTask } from '../../src/main/plan'
import type { FleetTask } from '../../src/shared/fleet'

const plan = (...titles: string[]): FleetTask[] => titles.map((title, i) => ({ id: `t${i + 1}x`, title, status: 'todo' }))

test('findTask: by id, by number in the plan, by title', () => {
  const tasks = plan('Add greet() with tests', 'Document greet in the README')
  assert.equal(findTask(tasks, 't2x')?.title, 'Document greet in the README')
  for (const ref of ['1', '#1', 'task 1', 'Task #1', '1.']) assert.equal(findTask(tasks, ref)?.id, 't1x', ref)
  assert.equal(findTask(tasks, 'add GREET() with tests')?.id, 't1x', 'case and punctuation do not matter')
  assert.equal(findTask(tasks, '3'), undefined, 'no such number')
  assert.equal(findTask(tasks, 'something else'), undefined)
  assert.equal(findTask(tasks, ''), undefined)
  assert.equal(findTask(tasks, undefined), undefined)
  assert.equal(findTask(plan('Same', 'Same'), 'same'), undefined, 'an ambiguous title links nothing')
})

test('guessTask: the assignment names the task, in other words', () => {
  const tasks = plan('Greeting module with unit tests', 'README usage section', 'CI workflow for tests')
  assert.equal(guessTask(tasks, 'Create src/greeting.js exporting greet(name) and its unit tests in test/greeting.test.js (module only)')?.id, 't1x')
  assert.equal(guessTask(tasks, 'Write the usage section of README.md describing greet()')?.id, 't2x')
  assert.equal(guessTask(tasks, 'Add a GitHub Actions CI workflow that runs the tests')?.id, 't3x')
  assert.equal(guessTask(tasks, 'Greeting module with unit tests')?.id, 't1x', 'the exact title')
})

test('guessTask: no link when unsure', () => {
  const tasks = plan('Write a.txt', 'Write b.txt')
  assert.equal(guessTask(tasks, 'Fix the flaky login test'), undefined, 'unrelated')
  assert.equal(guessTask(tasks, 'Write the txt files'), undefined, 'matches both equally')
  assert.equal(guessTask(tasks, 'Write a.txt')?.id, 't1x', 'but an exact title is enough')
  assert.equal(guessTask(plan('Parser for config files', 'Parser error messages'), 'Improve the parser'), undefined, 'half a title is not enough')
})

test('guessTask: only open tasks nobody owns', () => {
  const tasks = plan('Greeting module with unit tests', 'README usage section')
  tasks[0].owner = 'w1'
  tasks[0].status = 'doing'
  assert.equal(guessTask(tasks, 'Greeting module with unit tests'), undefined, 'already taken')
  tasks[1].status = 'done'
  assert.equal(guessTask(tasks, 'README usage section'), undefined, 'already done')
  assert.equal(guessTask([], 'anything'), undefined)
})
