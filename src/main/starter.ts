import fs from 'node:fs'
import path from 'node:path'
import type { GoalIdea } from '@shared/types'
import type { MainContext } from './context'
import { readRegularText } from './paths'
import { allowed } from './roots'
import { git } from './run'
import { nextPlanItem } from './sweep'

// A first goal, from the repo itself: what an empty board offers to put in the command bar.
//
// A new board with nothing on it asks "what now?", and the honest answer — type a goal — is only
// useful with an example that is about this repo. These are read, not generated: the next item of a
// plan the user already wrote, a TODO someone left in the code, a gap any repo of this shape has. No
// model call, because the point is to be there the moment the board opens, and nothing is changed.

export interface RepoSignals {
  plan: { file: string; item: string } | null
  todo: { file: string; line: number; text: string } | null
  /** a test runner or test folder was found; null when the repo's shape says nothing either way */
  hasTests: boolean | null
  hasReadme: boolean
}

const MAX = 3

/** The ideas for a repo with these signals, best first. Always at least one. */
export function ideasFrom(s: RepoSignals): GoalIdea[] {
  const out: GoalIdea[] = []
  if (s.plan) out.push({ text: s.plan.item, why: `next in ${s.plan.file}` })
  if (s.todo) out.push({ text: `Resolve the TODO in ${s.todo.file} (line ${s.todo.line}): ${s.todo.text}`, why: 'left in the code' })
  if (s.hasTests === false) out.push({ text: 'Set up a test runner and add a first test for the core logic', why: 'no tests found' })
  if (!s.hasReadme) out.push({ text: 'Write a README that says what this is and how to run it', why: 'no README' })
  if (s.hasTests) out.push({ text: 'Add tests for the code that would hurt most if it broke', why: 'a safe first goal: it changes no behaviour' })
  if (!out.length) out.push({ text: 'Find one bug and fix it, with a test that pins it', why: 'a small, checkable first goal' })
  return out.slice(0, MAX)
}

const TEST_DIRS = ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']
const TEST_FILES = ['pytest.ini', 'conftest.py', 'vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts', 'playwright.config.ts']
/** what `npm init` writes when there are no tests */
const NO_TESTS = /no test specified/i

/** Whether the repo has tests: true or false only when its shape says so, null when it can't tell. */
export function testsIn(root: string): boolean | null {
  const has = (p: string) => fs.existsSync(path.join(root, p))
  if (TEST_DIRS.some(has) || TEST_FILES.some(has)) return true
  let pkg: any = null
  try {
    pkg = JSON.parse(readRegularText(path.join(root, 'package.json'), 1024 * 1024))
  } catch {
    /* not a Node project, or not readable */
  }
  const script = pkg?.scripts?.test
  if (typeof script === 'string') return !NO_TESTS.test(script)
  // a package.json with no test script at all is a Node project without tests; anything else
  // (Rust's inline tests, Go's _test files next to the code) can't be told from the top level
  return pkg ? false : null
}

const hasReadme = (root: string) => {
  try {
    return fs.readdirSync(root).some((f) => /^readme(\.|$)/i.test(f))
  } catch {
    return true // unreadable: suggest nothing about it
  }
}

/** The first TODO or FIXME with something to say, in a file git tracks. */
export function parseTodo(out: string): RepoSignals['todo'] {
  for (const l of out.split('\n')) {
    const m = /^([^:]+):(\d+):.*?\b(?:TODO|FIXME)\b(?:\([^)]*\))?[\s:,-]*(.+)$/.exec(l)
    const text = m?.[3]?.replace(/\s*(\*\/|-->)\s*$/, '').trim()
    // "TODO" alone, or "TODO: x", says nothing a goal could be made of
    if (m && text && text.length >= 12) return { file: m[1]!, line: Number(m[2]), text: text.length > 120 ? text.slice(0, 119) + '…' : text }
  }
  return null
}

async function findTodo(root: string): Promise<RepoSignals['todo']> {
  const r = await git(root, ['grep', '-n', '-I', '-E', '-m', '1', '\\b(TODO|FIXME)\\b', '--', '.', ':(exclude)*.min.*', ':(exclude)*.lock', ':(exclude)*lock.json', ':(exclude)vendor', ':(exclude)third_party'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  // 1: nothing matched; anything else (not a repo, no git) is just no idea from this source
  return r.code === 0 ? parseTodo(r.stdout) : null
}

export async function goalIdeas(root: string): Promise<GoalIdea[]> {
  const todo = await findTodo(root).catch(() => null)
  return ideasFrom({ plan: nextPlanItem(root), todo, hasTests: testsIn(root), hasReadme: hasReadme(root) })
}

export function register(ctx: MainContext) {
  ctx.ipc.handle('starter:goals', (_e, root: string) => (allowed(root, 'starter:goals') ? goalIdeas(String(root)) : []))
}
