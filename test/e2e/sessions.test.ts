// Reopening the board resumes each console's own conversation. Claude Code's --continue picks the
// latest conversation in the folder, so with several consoles in one project every console used to
// resume the same one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App | undefined
after(async () => {
  if (process.env.E2E_SHOTS) await app?.screenshot(path.join(process.env.E2E_SHOTS, 'sessions.png')).catch(() => {})
  await app?.close()
})

const SCENARIO = { solo: [{ match: '.', workMs: 100, reply: 'noted' }] }
const nodeData = (id: string) =>
  app!.eval((id) => (window as any).__fleetboard.useApp.getState().project.workspaces.flatMap((w: any) => w.nodes).find((n: any) => n.id === id)?.data, id)
const send = (id: string, text: string) => app!.invoke('pty:deliver', id, text)
const starts = () => app!.fakeLog((e) => e.event === 'start')
const clears = () => app!.fakeLog((e) => e.event === 'clear')
const argAfter = (e: any, flag: string) => (e.args.includes(flag) ? e.args[e.args.indexOf(flag) + 1] : undefined)

test('several consoles in one project each get their own conversation back after a restart', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  app = await App.launch({ sandbox: sb, scenario: SCENARIO })
  await app.openProject(repo)
  const [a, b, c, d] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', count: 4 }) as string[])
  for (const id of [a, b, c, d]) await app.waitStatus(id, 'idle')
  assert.equal(await send(a, 'remember apple'), true)
  assert.equal(await send(b, 'remember banana'), true)
  assert.equal(await send(d, 'remember dates'), true)
  // c is never spoken to: Claude Code saves no conversation for it
  const ids = await Promise.all([a, b, c, d].map(async (id) => (await nodeData(id)).sessionId as string))
  assert.equal(new Set(ids).size, 4, 'four different conversations')
  assert.deepEqual(starts().map((e) => argAfter(e, '--session-id')).sort(), [...ids].sort(), 'each started under the id the board keeps')

  // a board saved before conversations had ids
  await app.eval((d) => (window as any).__fleetboard.useApp.getState().updateNodeData(d, { sessionId: undefined }), d)
  // b, the most recent conversation in the folder: what --continue would pick for everyone
  assert.equal(await send(b, 'and cherries'), true)
  await app.waitFor(() => app!.fakeLog((e) => e.event === 'prompt').length === 4, { label: 'every message reached its CLI' })
  assert.equal(await app.quitLikeUser(), true)
  const firstRun = starts().length

  app = await App.launch({ sandbox: sb, scenario: SCENARIO })
  await app.openProject(repo)
  await app.waitFor(async () => (await app!.texts('.resume-banner')).join(''), { label: 'resume banner' })
  await app.click('.resume-banner button', 'Yes')
  const restarts = () => starts().slice(firstRun)
  await app.waitFor(() => restarts().length === 4, { label: 'four consoles restarted' })
  const byId = (sid: string) => restarts().find((e) => argAfter(e, '--resume') === sid || argAfter(e, '--session-id') === sid)
  assert.deepEqual(byId(ids[0])?.history, ['remember apple'])
  assert.deepEqual(byId(ids[1])?.history, ['remember banana', 'and cherries'])
  assert.ok(byId(ids[0])!.args.includes('--resume') && byId(ids[1])!.args.includes('--resume'))
  // nothing was said in c: resuming would fail ("No conversation found"), so it starts again under its id
  assert.deepEqual(byId(ids[2])?.args.includes('--session-id') && byId(ids[2])?.history, [])
  // d had lost its id: the CLI's own resume, and Claude Code's SessionStart hook tells the board which conversation it is
  const legacy = restarts().filter((e) => e.args.includes('--continue'))
  assert.equal(legacy.length, 1)
  await app.waitFor(async () => (await nodeData(d)).sessionId === legacy[0].session, { label: 'd learned its conversation' })
  assert.equal(app.fakeLog((e) => e.event === 'session-error').length, 0, 'no CLI refused its session')
  for (const id of [a, b, c, d]) await app.waitStatus(id, 'idle')
})

test('/clear starts a new conversation, and the board follows it', async () => {
  const [a] = await app!.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' }) as string[])
  await app!.waitStatus(a, 'idle')
  const before = (await nodeData(a)).sessionId
  const n = clears().length
  assert.equal(await send(a, '/clear'), true)
  const cleared = await app!.waitFor(() => clears()[n]?.session, { label: 'cleared' })
  assert.notEqual(cleared, before)
  await app!.waitFor(async () => (await nodeData(a)).sessionId === cleared, { label: 'node follows the new conversation' })
})

test('a console in another workspace keeps its conversation id too', async () => {
  const [a] = await app!.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' }) as string[])
  await app!.waitStatus(a, 'idle')
  await app!.eval(() => (window as any).__fleetboard.useApp.getState().addWorkspace('Other'))
  const switched = await app!.eval(() => {
    const p = (window as any).__fleetboard.useApp.getState().project
    return p.workspaces.length > 1 && p.activeWorkspaceId !== p.workspaces[0].id
  })
  assert.ok(switched, 'another workspace is active')
  const n = clears().length
  assert.equal(await send(a, '/clear'), true)
  const cleared = await app!.waitFor(() => clears()[n]?.session, { label: 'cleared' })
  await app!.waitFor(async () => (await nodeData(a)).sessionId === cleared, { label: 'background console updated' })
})
