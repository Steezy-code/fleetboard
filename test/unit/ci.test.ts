// CI watcher: turning gh's run/check JSON into one state per item, and cleaning failed logs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLog, feedbackOf, overall, runState, summarizeChecks } from '../../src/main/ci'

test('a run is running until it completes, and only real failures are red', () => {
  assert.equal(runState('in_progress', null), 'running')
  assert.equal(runState('queued', ''), 'running')
  assert.equal(runState('completed', 'success'), 'passing')
  assert.equal(runState('completed', 'failure'), 'failing')
  assert.equal(runState('completed', 'timed_out'), 'failing')
  assert.equal(runState('completed', 'cancelled'), 'none')
  assert.equal(runState('completed', 'skipped'), 'none')
  // PR check rollups use upper case
  assert.equal(runState('COMPLETED', 'FAILURE'), 'failing')
})

test('a rerun replaces the older result of the same check', () => {
  const checks = summarizeChecks([
    { __typename: 'CheckRun', name: 'checks', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-19T10:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/1' },
    { __typename: 'CheckRun', name: 'checks', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-19T12:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/222/job/2' },
    { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-10-19T12:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/222/job/3' },
    { __typename: 'StatusContext', context: 'vercel', state: 'FAILURE', targetUrl: 'https://vercel.com/x', startedAt: '2026-10-19T12:00:00Z' }
  ])
  assert.deepEqual(
    checks.map((c) => [c.name, c.state, c.runId]),
    [
      ['checks', 'passing', 222],
      ['lint', 'running', 222],
      ['vercel', 'failing', null]
    ]
  )
  assert.equal(overall(checks.map((c) => c.state)), 'failing')
  assert.equal(overall(['passing', 'running']), 'running')
  assert.equal(overall([]), 'none')
})

test('failed logs lose the job/step columns and timestamps, and keep the end', () => {
  const raw = Array.from({ length: 300 }, (_, i) => `checks\tRun tests\t2026-10-19T11:40:${String(i % 60).padStart(2, '0')}.1234567Z line ${i}`).join('\n') +
    '\nchecks\tRun tests\t2026-10-19T11:41:00.0000000Z \x1b[31mError: expected 2, got 3\x1b[0m' +
    '\nchecks\tUNKNOWN STEP\t2026-10-19T11:41:00.0000000Z ##[error]Process completed with exit code 1.' +
    '\nchecks\tUNKNOWN STEP\t2026-10-19T11:41:01.0000000Z Post job cleanup.\n'
  const log = cleanLog(raw)
  const lines = log.split('\n')
  assert.match(lines[0], /142 earlier lines cut/)
  assert.equal(lines.at(-2), 'Error: expected 2, got 3')
  assert.equal(lines.at(-1), '##[error]Process completed with exit code 1.')
  assert.equal(lines[1], 'line 142')
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(log))
})

test('review feedback: what a person asked for, not bots, bare approvals, resolved threads or our agents', () => {
  const user = { login: 'alice', __typename: 'User' }
  const bot = { login: 'vercel', __typename: 'Bot' }
  const reviewBot = { login: 'copilot-pull-request-reviewer', __typename: 'Bot' }
  const got = feedbackOf({
    comments: {
      nodes: [
        { databaseId: 1, author: user, body: 'Can we rename this flag?', createdAt: '2026-10-19T10:00:00Z', url: 'u1' },
        { databaseId: 2, author: bot, body: 'Preview deployed to https://x.vercel.app', createdAt: '2026-10-19T10:01:00Z', url: 'u2' },
        { databaseId: 3, author: user, body: '🤖 Renamed it to --dry-run.', createdAt: '2026-10-19T10:30:00Z', url: 'u3' }
      ]
    },
    reviews: {
      nodes: [
        { databaseId: 10, author: user, body: '', state: 'APPROVED', submittedAt: '2026-10-19T11:00:00Z', url: 'u10' },
        { databaseId: 11, author: user, body: 'Needs a test for the empty case.', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-19T09:00:00Z', url: 'u11' },
        { databaseId: 12, author: reviewBot, body: 'Possible null dereference.', state: 'COMMENTED', submittedAt: '2026-10-19T09:30:00Z', url: 'u12' }
      ]
    },
    reviewThreads: {
      nodes: [
        { isResolved: false, path: 'src/a.ts', line: 42, comments: { nodes: [{ databaseId: 20, author: user, body: 'Off by one?', createdAt: '2026-10-19T09:10:00Z', url: 'u20' }] } },
        { isResolved: true, path: 'src/b.ts', line: 7, comments: { nodes: [{ databaseId: 21, author: user, body: 'Old nit', createdAt: '2026-10-19T08:00:00Z', url: 'u21' }] } }
      ]
    }
  })
  assert.deepEqual(
    got.map((c) => [c.id, c.kind, c.path ?? c.state ?? '']),
    [
      ['r11', 'review', 'CHANGES_REQUESTED'],
      ['i20', 'inline', 'src/a.ts'],
      ['r12', 'review', 'COMMENTED'],
      ['c1', 'comment', '']
    ]
  )
})
