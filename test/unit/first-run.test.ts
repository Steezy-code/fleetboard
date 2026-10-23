// The first five minutes: whether the home screen tells the truth about which agents can take work,
// and whether an empty board's first goals are about this repo and never nonsense. A wrong "ready"
// sends a first team into a sign-in prompt nobody sees; a goal made of "TODO" alone teaches the user
// the suggestions are noise.
import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ideasFrom, parseTodo, testsIn } from '../../src/main/starter'
import { agentById } from '../../src/shared/agents'

const { readinessOf, anyReady } = await import('@/chrome/readiness')

// ---------------------------------------------------------------- readiness

const claude = agentById('claude')!

test('readiness: looking, missing with its install line, installed but signed out, ready', () => {
  assert.equal(readinessOf(claude, undefined, undefined).state, 'scanning')
  assert.deepEqual(readinessOf(claude, { id: 'claude', path: null }, undefined), { state: 'missing', detail: 'Not installed', command: claude.install, homepage: claude.homepage })
  assert.deepEqual(readinessOf(claude, { id: 'claude', path: '/bin/claude' }, { signedIn: false }), { state: 'signin', detail: 'Installed, no sign-in found', command: 'claude' })
  assert.deepEqual(readinessOf(claude, { id: 'claude', path: '/bin/claude', version: '2.1.3 (Claude Code)' }, { signedIn: true, account: 'me@x.com' }), { state: 'ready', detail: 'me@x.com · 2.1.3 (Claude Code)' })
})

test('readiness: a CLI whose sign-in Fleetboard cannot read is taken at its word, not flagged', () => {
  const aider = agentById('aider')!
  assert.deepEqual(readinessOf(aider, { id: 'aider', path: '/bin/aider' }, undefined), { state: 'ready', detail: 'Installed' })
  assert.equal(anyReady([readinessOf(claude, { id: 'claude', path: null }, undefined), readinessOf(aider, { id: 'aider', path: '/bin/aider' }, undefined)]), true)
  assert.equal(anyReady([readinessOf(claude, { id: 'claude', path: '/bin/claude' }, { signedIn: false })]), false)
})

// ---------------------------------------------------------------- first goals

const none = { plan: null, todo: null, hasTests: null, hasReadme: true }

test('ideas: the plan first, then a TODO, then the gaps; never more than three, never none', () => {
  const all = ideasFrom({ plan: { file: 'PLAN.md', item: 'Export to CSV' }, todo: { file: 'src/a.ts', line: 4, text: 'handle empty input' }, hasTests: false, hasReadme: false })
  assert.deepEqual(
    all.map((i) => i.text),
    ['Export to CSV', 'Resolve the TODO in src/a.ts (line 4): handle empty input', 'Set up a test runner and add a first test for the core logic']
  )
  assert.equal(all[0]!.why, 'next in PLAN.md')
  assert.equal(ideasFrom(none).length, 1, 'something to start from even when the repo says nothing')
  assert.match(ideasFrom({ ...none, hasTests: true })[0]!.text, /^Add tests/)
  assert.ok(!ideasFrom({ ...none, hasTests: null }).some((i) => /test runner/.test(i.text)), 'unsure is not "no tests"')
})

test('parseTodo: the first TODO with something to say, from git grep -n', () => {
  const out = ['src/a.ts:3:// TODO', 'src/b.ts:9:  // TODO: x', 'src/c.ts:12:  // TODO(luke): retry when the socket drops mid-write', 'src/d.ts:1:// FIXME later'].join('\n')
  assert.deepEqual(parseTodo(out), { file: 'src/c.ts', line: 12, text: 'retry when the socket drops mid-write' })
  assert.deepEqual(parseTodo('lib/x.py:40:    # FIXME: the cache is never invalidated on rename'), { file: 'lib/x.py', line: 40, text: 'the cache is never invalidated on rename' })
  assert.equal(parseTodo('a.css:1:/* TODO: tidy */'), null, 'too short to be a goal')
  assert.equal(parseTodo(''), null)
  assert.equal(parseTodo('x.ts:2:const TODOS = loadTodoList(file)'), null, 'a word that merely starts with TODO')
})

test('testsIn: a test folder or a real test script yes; npm init\'s placeholder no; a bare repo unknown', () => {
  const dir = (files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-first-'))
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true })
      fs.writeFileSync(path.join(d, f), body)
    }
    return d
  }
  assert.equal(testsIn(dir({ 'test/a.test.ts': '' })), true)
  assert.equal(testsIn(dir({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })), true)
  assert.equal(testsIn(dir({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), false)
  assert.equal(testsIn(dir({ 'package.json': JSON.stringify({ name: 'x' }) })), false)
  assert.equal(testsIn(dir({ 'Cargo.toml': '[package]' })), null)
})
