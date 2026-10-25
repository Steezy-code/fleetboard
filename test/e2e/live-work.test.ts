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
  // a picture of a failure is what is worth keeping; and the app is closed whatever the picture does,
  // since it runs detached and would outlive the test
  try {
    if (process.env.E2E_SHOTS && !t.passed) await app.screenshot(path.join(process.env.E2E_SHOTS, `${t.name.replace(/\W+/g, '-')}.png`)).catch(() => {})
  } finally {
    await app.close()
    app = null
  }
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

  // merged into the Lead's worktree, the check does not run on its own: that would run the agents'
  // code (mayRun). It says the merged commit is waiting, and runs when the user asks
  await app!.waitFor(async () => (await fleet(projectId)).ready, { label: 'Ready card', timeout: 60_000 })
  const waiting = await app!.waitFor(async () => (await fleet(projectId)).check?.unchecked ?? null, { label: 'merged work waiting', timeout: 20_000 })
  assert.equal(waiting.length, 40)
  assert.equal((await fleet(projectId)).check.runs.length, 1, 'nothing ran on the merged work by itself')
  await app!.waitFor(async () => (/new work not checked/.test(await text('.plan-check')) ? true : null), { label: 'waiting on the plan' })
  assert.equal(await app!.invoke('fleet:runCheck', projectId), true)
  const after = await app!.waitFor(async () => {
    const c = (await fleet(projectId)).check
    return c && !c.running && c.runs.length >= 2 ? c : null
  }, { label: 'run after the merge', timeout: 20_000 })
  assert.equal(after.runs.at(-1).code, 0)
  assert.equal(after.runs.at(-1).head, waiting, 'against the commit that was merged')
  assert.equal(after.unchecked, undefined, 'and that answers it')
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

/** Put a team on the board's mirror without running one (debug.ts: useFleet is writable for this). */
const inject = (state: (projectId: string, now: number) => object, projectId: string, live: string[] = []) =>
  app!.eval(
    ({ src, projectId, live }) => {
      const fb = (window as any).__fleetboard
      for (const id of live) fb.useApp.getState().setLive(id, true)
      // eslint-disable-next-line no-new-func
      fb.useFleet.setState({ state: new Function('projectId', 'now', `return (${src})(projectId, now)`)(projectId, Date.now()) })
    },
    { src: state.toString(), projectId, live }
  )

test('a worker gone quiet raises the ambient line and an Inbox card, with nothing estimated anywhere', async () => {
  const { projectId } = await launch({})
  await inject(
    (projectId, now) => {
      const base = { agentId: 'claude', projectId, cwd: '/x', status: 'working' }
      return {
        projectId,
        projectPath: '/x',
        members: {
          lead: { ...base, id: 'lead', role: 'lead', name: 'Lead', createdAt: now - 30 * 60000, lastOutputAt: now },
          ada: { ...base, id: 'ada', role: 'worker', name: 'Ada', leadId: 'lead', createdAt: now - 25 * 60000, lastOutputAt: now - 20 * 60000 }
        },
        tasks: [{ id: 't1', title: 'Write the parser', owner: 'ada', status: 'doing', startedAt: now - 25 * 60000 }],
        messages: [],
        asks: [],
        ready: null
      }
    },
    projectId,
    ['lead', 'ada']
  )
  const line = await app!.waitFor(async () => (await text('.ambient-line .ambient-text')) || null, { label: 'ambient line' })
  assert.equal(line, 'Ada has been silent for 20 min on “Write the parser”.')
  assert.match(await text('.ambient-badge'), /Oracle/i)
  const card = await app!.waitFor(async () => (await app!.texts('.it-card[data-kind="notice"]')).find((t) => /silent/.test(t)), { label: 'stall card' })
  assert.match(card, /has been silent for 20 min/)

  await app!.click('.ambient-line .icon-btn')
  await app!.waitFor(async () => ((await text('.ambient-line')) === '' ? true : null), { label: 'line dismissed' })
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await text('.ambient-line'), '', 'and it stays dismissed')
  assert.ok((await app!.texts('.it-card[data-kind="notice"]')).some((t) => /silent/.test(t)), 'the Inbox card is its own: still there to act on')
})

test('work on track shows no line at all', async () => {
  const { projectId } = await launch({})
  await inject(
    (projectId, now) => ({
      projectId,
      projectPath: '/x',
      members: { lead: { agentId: 'claude', projectId, cwd: '/x', status: 'working', id: 'lead', role: 'lead', name: 'Lead', createdAt: now - 5 * 60000, lastOutputAt: now } },
      tasks: [{ id: 't1', title: 'Write the parser', status: 'doing', startedAt: now - 4 * 60000, estimate: 10 }],
      messages: [],
      asks: [],
      ready: null
    }),
    projectId,
    ['lead']
  )
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(await text('.ambient-line'), '')
})

test('the Ready card shows the choices each worker says it made', async () => {
  const { projectId } = await launch({})
  await inject(
    (projectId, now) => ({
      projectId,
      projectPath: '/x',
      members: {
        lead: { agentId: 'claude', projectId, cwd: '/x', status: 'reported', id: 'lead', role: 'lead', name: 'Lead', branch: 'fleet/x', createdAt: now - 9 * 60000 },
        ada: {
          agentId: 'claude',
          projectId,
          cwd: '/x/ada',
          status: 'merged',
          id: 'ada',
          role: 'worker',
          name: 'Ada',
          leadId: 'lead',
          owns: ['a.txt'],
          doneWhen: 'a.txt exists',
          report: 'Wrote a.txt\nDecisions:\n- kept the parser pure: easier to test\n- one file over two: nothing else reads it',
          createdAt: now - 8 * 60000
        }
      },
      tasks: [],
      messages: [],
      asks: [],
      ready: { leadId: 'lead', branch: 'fleet/x', summary: '- Added a.txt', commits: 1, files: ['a.txt'], at: now }
    }),
    projectId
  )
  const decisions = await app!.waitFor(async () => (await text('.it-card[data-kind="ready"] .it-claim-decisions')) || null, { label: 'decisions on the Ready card' })
  assert.deepEqual(decisions.split('\n').map((l) => l.replace(/^↳\s*/, '')), ['kept the parser pure: easier to test', 'one file over two: nothing else reads it'])
})

test('Ready verification is observed at the offered commit and stale cards cannot rerun it', async () => {
  const { projectId, repo } = await launch({ lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] } })
  await app!.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt', charter: charter('test -f a.txt') })
  const ready = await app!.waitFor(async () => (await fleet(projectId)).ready, { label: 'Ready', timeout: 60_000 })
  await app!.waitFor(async () => !(await fleet(projectId)).check?.running, { label: 'background check finished' })
  const evidence = await app!.invoke('fleet:verifyReady', projectId, ready.head)
  assert.equal(evidence.command, 'test -f a.txt')
  assert.equal(evidence.run.head, ready.head)
  assert.equal(evidence.run.code, 0)
  assert.equal(evidence.run.stable, true)
  await assert.rejects(() => app!.invoke('fleet:verifyReady', projectId, 'old'), /changed/)
  assert.equal((await fleet(projectId)).ready.evidence.run.head, ready.head)
})
