// The CI watcher can spawn a whole agent when a run goes red, with nobody watching. What stops it
// doing that over and over is one Map and three rules in applyCiStatus, and a break in them is
// invisible: no error, no failure, just an agent and its tokens every poll. `test/unit/ci.test.ts`
// covers the main-process side of CI; this is the side that acts.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { applyCiStatus, useCi } = await import('@/workbench/ciStore')
const { useUsage, DEFAULT_BUDGETS } = await import('@/continuity/usageStore')

const run = (id: number, state: string) => ({
  id,
  workflow: 'CI',
  title: 't',
  branch: 'main',
  sha: 'abc',
  event: 'push',
  state,
  detail: state,
  createdAt: '2026-01-01T00:00:00Z',
  url: 'https://example.invalid/run'
})
const status = (r: unknown[]) => ({ ok: true as const, at: Date.now(), branch: 'main', slug: 'o/r', runs: r, prs: [] })

/** Consoles the watcher put on the board (they start when mounted, so nothing spawns here). */
const spawned = () => (useApp.getState().project?.workspaces ?? []).flatMap((w) => w.nodes).filter((n) => n.type === 'console').length

beforeEach(() => {
  ipc.sent.length = 0
  ipc.handlers.clear()
  ipc.handle('ci:failedLog', () => ({ ok: true, log: 'boom' }))
  ipc.handle('journal:append', () => {})
  ipc.handle('store:saveProject', () => {})
  useCi.setState({ path: '/tmp/p', status: null } as never)
  useApp.setState({
    toasts: [],
    project: {
      schema: 1,
      id: 'p',
      name: 'p',
      path: '/tmp/p',
      activeWorkspaceId: 'w',
      lastOpened: 0,
      extras: { ciAutoFix: true },
      workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
    }
  } as never)
})

test('the first status never sends an agent anywhere', async () => {
  // opening the app on a branch that has been red for a week is not news, and must not spend anything
  applyCiStatus(status([run(1, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(spawned(), 0, 'nothing on the first poll')
  assert.deepEqual((useApp.getState() as never as { toasts: { text: string }[] }).toasts, [], 'and nothing said')
})

test('going red sends one agent, and staying red does not send another', async () => {
  applyCiStatus(status([run(1, 'passing')]) as never) // first poll: green, remembered
  applyCiStatus(status([run(2, 'failing')]) as never) // turned red
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 1, 'one agent for the failure')

  for (let i = 0; i < 4; i++) applyCiStatus(status([run(2, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 1, 'the same failure, poll after poll, is still one agent')
})

test('one agent per failing thing, however many times it fails again', async () => {
  applyCiStatus(status([run(1, 'passing')]) as never)
  applyCiStatus(status([run(2, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 1)

  // a different run id, so this *is* a new failure and is reported — but the agent already sent is
  // still on that workflow, so it is told rather than joined
  applyCiStatus(status([run(3, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 1, 'the agent already on it keeps it')

  // once that console is gone, the next failure gets a fresh one
  useApp.getState().mutateEveryWs((w) => ({ ...w, nodes: w.nodes.filter((n) => n.type !== 'console') }))
  applyCiStatus(status([run(4, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 1, 'one again, not none')
})

test('green again is said, not acted on', async () => {
  applyCiStatus(status([run(1, 'failing')]) as never)
  applyCiStatus(status([run(2, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  const after = spawned()
  applyCiStatus(status([run(3, 'passing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), after, 'nothing is spawned for good news')
  const toasts = (useApp.getState() as never as { toasts: { text: string }[] }).toasts.map((t) => t.text)
  assert.ok(toasts.some((t) => /CI is green again/.test(t)), JSON.stringify(toasts))
})

test('with auto-fix off, a failure is reported and nothing is spawned', async () => {
  useApp.setState({ project: { ...(useApp.getState().project as never as object), extras: {} } } as never)
  applyCiStatus(status([run(1, 'passing')]) as never)
  applyCiStatus(status([run(2, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 0)
  const toasts = (useApp.getState() as never as { toasts: { text: string }[] }).toasts.map((t) => t.text)
  assert.ok(toasts.some((t) => /CI failed/.test(t)), JSON.stringify(toasts))
})

test('past the spend ceiling the failure is still reported, and no agent is sent', async () => {
  // the most expensive thing the app does on its own, so it is the clearest case for the ceiling
  useUsage.setState({
    budgets: { ...DEFAULT_BUDGETS, claude: { session: 1000, week: 10_000, ceiling: 0.9 } },
    limits: { claude: { agent: 'claude', estimate: true, session: { tokens: 1000, start: 0, resetsAt: 0, active: true, byModel: [] }, week: { tokens: 0, start: 0, resetsAt: 0, active: true, byModel: [] }, lastActivity: 0 } }
  } as never)
  applyCiStatus(status([run(1, 'passing')]) as never)
  applyCiStatus(status([run(2, 'failing')]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 0, 'nothing spawned')
  const toasts = (useApp.getState() as never as { toasts: { text: string }[] }).toasts.map((t) => t.text)
  assert.ok(toasts.some((t) => /CI failed/.test(t)), 'the failure is still news')
  assert.ok(toasts.some((t) => /stopped sending an agent at a CI failure by itself/.test(t)), JSON.stringify(toasts))
  useUsage.setState({ budgets: DEFAULT_BUDGETS, limits: {} } as never)
})

const pr = (n: number, state: string, fork: boolean) => ({
  number: n,
  title: 'a title its author wrote',
  branch: 'feature',
  url: 'https://example.invalid/pr',
  fork,
  isDraft: false,
  state,
  checks: [{ name: 'test', state, runId: n * 10 }]
})
const prStatus = (prs: unknown[]) => ({ ok: true as const, at: Date.now(), branch: 'main', slug: 'o/r', runs: [], prs })
const consoles = () => (useApp.getState().project?.workspaces ?? []).flatMap((w) => w.nodes).filter((n) => n.type === 'console')

test('a fork’s PR going red is never fixed on its own: its title and log are a stranger’s words', async () => {
  applyCiStatus(prStatus([pr(7, 'passing', true)]) as never)
  applyCiStatus(prStatus([pr(7, 'failing', true)]) as never)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(spawned(), 0)
})

test('a CI fixer never auto-approves, whatever the global setting: its prompt holds a CI log', async () => {
  useApp.setState((s) => ({ settings: { ...s.settings, autoApprove: true } }))
  applyCiStatus(prStatus([pr(8, 'passing', false)]) as never)
  applyCiStatus(prStatus([pr(8, 'failing', false)]) as never)
  await new Promise((r) => setTimeout(r, 30))
  const [fixer] = consoles()
  assert.ok(fixer, 'a same-repo PR still gets its fixer')
  assert.equal(fixer!.data.autoApprove, false)
  useApp.setState((s) => ({ settings: { ...s.settings, autoApprove: false } }))
})
