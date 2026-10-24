// The app spends tokens on its own: a loop types into consoles on a schedule, a goal judge runs a CLI
// on every fire after the first, the CI watcher spawns a whole agent when a run goes red. The usage
// pill has always shown how much of the budget that eats — in red past 90% — and nothing acted on it.
// describeLoop even tells the user a loop with no limits "runs until you turn it off".
//
// So: a ceiling, and the rule that it only ever stops the app, never the user.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { useUsage, DEFAULT_BUDGETS } = await import('@/continuity/usageStore')
const { useApp } = await import('@/state/store')
const { atCeiling, maySpendOn, spendable } = await import('@/engine/guards')

const window_ = (tokens: number) => ({ tokens, start: 0, resetsAt: 0, active: true, byModel: [] })
const limits = (agent: string, session: number, week = 0) => ({
  [agent]: { agent, estimate: true as const, session: window_(session), week: window_(week), lastActivity: 0 }
})
const ws = (nodes: unknown[]) => ({ id: 'w', name: 'W', nodes, groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} })
const console_ = (id: string, agentId: string) => ({ id, type: 'console', x: 0, y: 0, w: 1, h: 1, z: 1, data: { name: id, agentId } })

beforeEach(() => {
  ipc.handle('journal:append', () => {})
  useUsage.setState({ budgets: { ...DEFAULT_BUDGETS, claude: { session: 1000, week: 10_000, ceiling: 0.9 } } as any, limits: {} })
  useApp.setState({ toasts: [] } as any)
})

test('an agent past its ceiling in either window is past it', () => {
  useUsage.setState({ limits: limits('claude', 899) as any })
  assert.equal(atCeiling('claude'), false, 'under it')
  useUsage.setState({ limits: limits('claude', 900) as any })
  assert.equal(atCeiling('claude'), true, 'the session window')
  useUsage.setState({ limits: limits('claude', 0, 9500) as any })
  assert.equal(atCeiling('claude'), true, 'or the week, which is the one a long night reaches')
})

test('a ceiling of zero is off, and an agent with no usage log is never measured', () => {
  useUsage.setState({
    budgets: { ...DEFAULT_BUDGETS, claude: { session: 1000, week: 10_000, ceiling: 0 } } as any,
    limits: limits('claude', 100_000) as any
  })
  assert.equal(atCeiling('claude'), false, 'off means off')
  // a custom agent (a shell command the user wired up) writes no usage log, so there is nothing to
  // compare against: it must not be stopped on the strength of a number we do not have
  assert.equal(atCeiling('my-own-cli'), false)
  assert.equal(atCeiling(''), false)
})

test('one exhausted agent does not stop a loop firing into another', () => {
  useUsage.setState({ limits: limits('claude', 1000) as any })
  useApp.setState({ project: { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [ws([console_('a', 'claude'), console_('b', 'codex'), console_('c', 'my-own-cli')])] } } as any)

  assert.deepEqual(spendable(['a', 'b', 'c'], 'a loop'), ['b', 'c'], 'only the one that is out')
  const toasts = () => ((useApp.getState() as any).toasts ?? []).map((t: any) => t.text)
  assert.match(toasts().join(' '), /claude is at 90% of its budget/)
  assert.match(toasts().join(' '), /Your own prompts still go through/, 'and says what is still possible')

  // asked again straight away — a loop ticks every five seconds — it does not say it again
  const n = toasts().length
  spendable(['a'], 'a loop')
  assert.equal(toasts().length, n, 'once an hour per agent, not once per tick')
  assert.deepEqual(spendable(['a'], 'a loop'), [], 'but it still refuses')
})

test('a one-shot run of a named agent is refused the same way', () => {
  useUsage.setState({ limits: limits('claude', 1000) as any })
  assert.equal(maySpendOn('claude', 'judging whether a loop can stop'), false)
  assert.equal(maySpendOn('codex', 'judging whether a loop can stop'), true, 'another agent is unaffected')
})

// The budget used to default to six million tokens a session and eighty million a week — numbers
// nobody chose, for limits that are not on this machine. Unset, there is nothing to be a share of, so
// the ceiling cannot fire: the user sets a budget to get the gate, and the panel says so.
test('with no budget set, nothing is gated however much has been spent', () => {
  useUsage.setState({ budgets: { ...DEFAULT_BUDGETS } as any, limits: limits('claude', 50_000_000, 900_000_000) as any })
  assert.equal(DEFAULT_BUDGETS.claude.session, 0, 'no invented session budget')
  assert.equal(DEFAULT_BUDGETS.claude.week, 0, 'nor a weekly one')
  assert.equal(atCeiling('claude'), false)
})

test('a budget the user sets gates exactly as before', () => {
  useUsage.setState({
    budgets: { ...DEFAULT_BUDGETS, claude: { session: 2_000_000, week: 0, ceiling: 0.9 } } as any,
    limits: limits('claude', 1_800_000) as any
  })
  assert.equal(atCeiling('claude'), true, 'the session budget they set')
  useUsage.setState({ limits: limits('claude', 1_700_000) as any })
  assert.equal(atCeiling('claude'), false)
})
