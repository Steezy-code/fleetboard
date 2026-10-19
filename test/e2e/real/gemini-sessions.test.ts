// The real Gemini CLI (against a local mock of the Gemini API): consoles in one project, the app
// restarted, each resumes its own session; one never spoken to starts cleanly instead of failing (Gemini
// saves a session as soon as it starts, and then will neither resume it nor start under its id again).
// Quitting also ends the Gemini processes, which ignore SIGHUP.
// Manual run, skipped unless FLEETBOARD_REAL_GEMINI is the gemini binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'
import { startMockGemini } from '../../support/mock-responses'
import { setupGemini } from './gemini-setup'

const GEMINI = process.env.FLEETBOARD_REAL_GEMINI

test('real Gemini: each console resumes its own session; an untouched one starts again', { skip: !GEMINI, timeout: 6 * 60_000 }, async () => {
  const mock = await startMockGemini()
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  setupGemini(sb, repo, GEMINI!, mock.port)

  let app = await App.launch({ sandbox: sb })
  const nodeData = (id: string) => app.eval((id) => (window as any).__fleetboard.useApp.getState().project.workspaces.flatMap((w: any) => w.nodes).find((n: any) => n.id === id)?.data, id)
  const tell = async (id: string, text: string) => {
    const ok = await app.invoke('pty:deliver', id, text)
    assert.equal(ok, true, ok ? '' : `could not type into ${id} (${await app.status(id)}): ${await app.invoke('pty:tail', id, 3000)}`)
    await app.waitStatus(id, 'working', 30_000).catch(() => {})
    await app.waitStatus(id, 'idle', 60_000)
  }
  try {
    await app.openProject(repo)
    const [a, b, c] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'gemini', count: 3 }) as string[])
    for (const id of [a, b, c]) await app.waitStatus(id, 'idle', 60_000)
    await tell(a, 'pelican')
    await tell(b, 'lighthouse')
    const before = await Promise.all([a, b, c].map(async (id) => (await nodeData(id)).sessionId as string))
    assert.equal(new Set(before).size, 3, 'three sessions')
    assert.equal(await app.quitLikeUser(), true, 'the app quits')

    app = await App.launch({ sandbox: sb })
    await app.openProject(repo)
    await app.waitFor(async () => (await app.texts('.resume-banner')).join(''), { label: 'resume banner' })
    await app.click('.resume-banner button', 'Yes')
    for (const id of [a, b, c]) await app.waitStatus(id, 'idle', 60_000)
    const after = await Promise.all([a, b, c].map(async (id) => (await nodeData(id)).sessionId as string))
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'a and b resumed their own')
    // c's empty session is either still there (taken: c gets a new id) or already deleted by Gemini's
    // cleanup when its siblings started (free: c keeps its id); either way c must start, fresh
    const n = mock.requests.length
    for (const id of [a, b, c]) await tell(id, 'which word')
    const asked = mock.requests.slice(n).filter((r) => r.last === 'which word')
    assert.deepEqual(asked.map((r) => r.first), ['pelican', 'lighthouse', 'which word'], `the model saw: ${JSON.stringify(asked)}`)
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-gemini-sessions.png')).catch(() => {})
    await app.close()
    await mock.close()
  }
})
