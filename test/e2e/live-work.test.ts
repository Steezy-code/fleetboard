// Live work against the charter, end to end: what a tile says its agent is doing, how long each task
// has taken against its estimate, what a worker has changed before it reports, the charter's check
// running in the Lead's worktree, and Oracle's one quiet line when the work drifts.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App | null = null
afterEach(async (t) => {
  if (!app) return
  if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, `${t.name.replace(/\W+/g, '-')}.png`))
  await app.close()
  app = null
})

async function launch(scenario: object, files?: Record<string, string>) {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'repo', files)
  app = await App.launch({ sandbox: sb, scenario })
  const projectId = await app.openProject(repo)
  return { sb, repo, projectId, app }
}

const pill = (id: string) => app!.eval((id) => document.querySelector(`[data-node-id="${id}"] .status-pill`)?.textContent ?? '', id)

test('the tile says what its agent is doing while it does it, and its plain status otherwise', async () => {
  await launch({ solo: [{ match: 'build', bash: 'sleep 3', holdMs: 4000, reply: 'built' }] })
  const id = await app!.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', autoApprove: true })[0] as string)
  await app!.waitStatus(id, 'idle')
  assert.equal((await pill(id)).toLowerCase(), 'ready')
  await app!.eval((id) => (window as any).__fleetboard.sendToConsole(id, 'build it', true), id)
  await app!.waitFor(async () => ((await pill(id)) === 'running `sleep 3`' ? true : null), { label: 'activity on the pill', timeout: 10_000 })
  await app!.waitStatus(id, 'idle', 15_000)
  assert.equal((await pill(id)).toLowerCase(), 'ready', 'the activity goes when the work does')
})

const fleet = (projectId: string) => app!.invoke('fleet:state', projectId)
const text = (selector: string) => app!.eval((sel) => [...document.querySelectorAll(sel)].map((e) => (e as HTMLElement).innerText).join('\n'), selector)

/** A charter as the gate hands it to fleet:startLead. */
const charter = (doneWhen: string, estimate?: number) => ({ request: 'add a.txt', understood: 'Add a.txt', assumptions: [], wontTouch: [], doneWhen, confidence: 50, at: Date.now(), ...(estimate ? { estimate } : {}) })

test('while a worker works: its changes, its task’s clock against the estimate, and the charter’s check in the Lead’s worktree', async () => {
  const { projectId, repo } = await launch({
    lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada', estimate: 5 }] },
    workers: { Ada: { holdMs: 25_000 } }
  })
  await app!.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt', charter: charter('test -f a.txt', 30) })

  // the baseline, before any work has landed: the file is not there yet
  const base = await app!.waitFor(async () => (await fleet(projectId)).check?.runs[0], { label: 'baseline run', timeout: 20_000 })
  assert.equal(base.code, 1)

  // the work is on disk in Ada's worktree, unreported: visible on its tile and on the plan before any Ready card
  const ada = await app!.waitFor(async () => Object.values((await fleet(projectId)).members).find((m: any) => m.name === 'Ada' && m.diff?.files) as any, { label: 'live diff', timeout: 30_000 })
  assert.deepEqual([ada.diff.files, ada.diff.add, ada.diff.del], [1, 1, 0])
  assert.equal((await fleet(projectId)).ready, null, 'seen before Ready, not at it')
  await app!.waitFor(async () => ((await text(`[data-node-id="${ada.id}"] .fleet-diff`)) === '1 file +1 −0' ? true : null), { label: 'diff on the tile' })
  assert.equal(await pill(ada.id), 'writing `a.txt`', 'and what it is doing')

  const plan = await app!.waitFor(async () => (await text('.plan-body')) || null, { label: 'plan node' })
  assert.match(plan, /est 5 min/, 'the task’s estimate')
  assert.match(plan, /est 30 min/, 'the job’s, from the charter')
  assert.match(plan, /test -f a\.txt/, 'the check, verbatim')
  assert.match(plan, /1 file \+1 −0/, 'the worker’s changes on the plan too')
  const task = (await fleet(projectId)).tasks[0]
  assert.ok(task.startedAt, 'startedAt populates')

  // merged into the Lead's worktree, the check runs again there and passes
  await app!.waitFor(async () => (await fleet(projectId)).ready, { label: 'Ready card', timeout: 60_000 })
  const after = await app!.waitFor(async () => {
    const c = (await fleet(projectId)).check
    return c && !c.running && c.runs.length >= 2 ? c : null
  }, { label: 'run after the merge', timeout: 20_000 })
  assert.equal(after.runs.at(-1).code, 0)
  assert.equal(after.runs.at(-1).head?.length, 40, 'against the commit that was merged')
  const done = (await fleet(projectId)).tasks[0]
  assert.ok(done.endedAt >= done.startedAt, 'the task’s clock stopped when it was done')
  await app!.waitFor(async () => (/passing/.test(await text('.plan-check')) ? true : null), { label: 'passing on the plan' })

  // switched off, it says so and starts nothing more
  assert.equal(await app!.invoke('fleet:checkOff', projectId, true), true)
  await app!.waitFor(async () => (/off · last passing/.test(await text('.plan-check')) ? true : null), { label: 'off on the plan' })
  const ran = (await fleet(projectId)).check.runs.length
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal((await fleet(projectId)).check.runs.length, ran)
})
