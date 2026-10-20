// A team member's worktree and branch hold work that exists nowhere else: a worker's edits are only
// ever committed when it reports. These are the two decisions that used to throw that work away —
// which worktree is a member's own to remove, and whether its branch is safe to delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wt-'))
const { ownWorktree, containedIn } = await import('../../src/main/fleet')

const TREES = path.join('/tmp', 'fb-trees')
const at = (...p: string[]) => path.join(TREES, ...p)

test("a reviewer never removes the worktree it shares with its lead", () => {
  // fleet_spawn_reviewer gives a reviewer the lead's cwd and no branch of its own, so dismissing
  // one used to run `git worktree remove --force` on the lead's folder.
  const leadCwd = at('goal-1234-lead')
  const lead = { id: 'con_lead', cwd: leadCwd, status: 'working' }
  const reviewer = { id: 'con_rev', cwd: leadCwd, status: 'working' }
  const members = [lead, reviewer]
  assert.equal(ownWorktree(reviewer, members, TREES), false, "the reviewer must not remove the lead's worktree")
  assert.equal(ownWorktree(lead, members, TREES), false, 'nor the lead while the reviewer is still in it')

  // once the reviewer is closed the lead's own worktree is its own again
  assert.equal(ownWorktree(lead, [lead, { ...reviewer, status: 'closed' }], TREES), true)
})

test("a worker owns its own worktree", () => {
  const lead = { id: 'con_lead', cwd: at('goal-lead'), status: 'working' }
  const worker = { id: 'con_w1', cwd: at('goal-maya'), status: 'working' }
  assert.equal(ownWorktree(worker, [lead, worker], TREES), true)
})

test('a folder outside the worktrees folder is never removed', () => {
  const mine = { id: 'a', cwd: '/home/user/code/myrepo', status: 'working' }
  assert.equal(ownWorktree(mine, [mine], TREES), false, "the user's own checkout")
  // a sibling folder must not pass as being inside: startsWith without the separator said it was
  const sibling = { id: 'b', cwd: TREES + '-old/x', status: 'working' }
  assert.equal(ownWorktree(sibling, [sibling], TREES), false, 'worktrees-old is not inside worktrees')
  const exact = { id: 'c', cwd: TREES, status: 'working' }
  assert.equal(ownWorktree(exact, [exact], TREES), false, 'the worktrees folder itself')
})

test("a branch is only deleted once the lead's branch really holds its commits", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wt-repo-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env })
  const commit = (f: string, c: string) => {
    fs.writeFileSync(path.join(repo, f), c)
    sh('add', '-A')
    sh('commit', '-qm', `add ${f}`)
  }
  sh('init', '-q', '-b', 'main')
  commit('a.txt', 'a')
  sh('branch', 'fleet/lead')
  sh('checkout', '-q', '-b', 'fleet/lead--maya', 'fleet/lead')
  commit('maya.txt', 'maya')
  // a second worker that the lead never merged (it reported "blocked", or its console died)
  sh('checkout', '-q', '-b', 'fleet/lead--rafa', 'fleet/lead')
  commit('rafa.txt', 'rafa')
  // the lead merges only Maya
  sh('checkout', '-q', 'fleet/lead')
  sh('merge', '-q', '--no-ff', '-m', 'merge maya', 'fleet/lead--maya')

  assert.equal(await containedIn(repo, 'fleet/lead--maya', 'fleet/lead'), true, 'merged: safe to delete')
  assert.equal(await containedIn(repo, 'fleet/lead--rafa', 'fleet/lead'), false, 'never merged: must be kept')
  // no branch of its own (a reviewer) means there is nothing to lose
  assert.equal(await containedIn(repo, undefined, 'fleet/lead'), true)
  // a lead with no branch at all: nothing can be shown to be safe
  assert.equal(await containedIn(repo, 'fleet/lead--rafa', undefined), false)
  // a branch that does not exist is not "contained"
  assert.equal(await containedIn(repo, 'fleet/lead--gone', 'fleet/lead'), false)
})

test('a project id is checked before it becomes a file or folder name', async () => {
  // it arrives over IPC and is used both as ~/.fleetboard/fleet/<id>.json and as a folder under
  // ~/.fleetboard/worktrees/<id>/. store.ts has always checked exactly this; fleet.ts did not.
  const { stateFileFor } = await import('../../src/main/fleet')
  for (const bad of ['../../.config/autostart/x', '..', 'a/b', 'a\\b', '', 'has space', 'dot.dot', 'x/../../y']) {
    assert.throws(() => stateFileFor(bad), /Bad project id/, JSON.stringify(bad))
  }
  // what store.projectIdFor actually produces is a short hash, and ids with dashes exist too
  for (const good of ['3f8a1c2d9e0b', 'abc-123_XYZ']) {
    const f = stateFileFor(good)
    assert.ok(f.endsWith(`${good}.json`), f)
    assert.ok(!f.includes('..'), f)
  }
})
