// A team with a real Codex worker (against a local mock of the model API that acts like a worker):
// the scripted lead starts it, Codex gets its brief, reaches the fleet tools over MCP with its bearer
// token, writes its file in its own worktree and reports; the work is merged and lands in the checkout.
// Manual run, skipped unless FLEETBOARD_REAL_CODEX and FLEETBOARD_CODEX_CATALOG are set (see codex-console).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'
import { startMockResponses } from '../../support/mock-responses'
import { setupCodex, stopCodexDaemons } from './codex-setup'

const CODEX = process.env.FLEETBOARD_REAL_CODEX
const CATALOG = process.env.FLEETBOARD_CODEX_CATALOG

test('real Codex as a team worker: brief, fleet tools over MCP, report, merge', { skip: !(CODEX && CATALOG), timeout: 5 * 60_000 }, async () => {
  const mock = await startMockResponses()
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  setupCodex(sb, repo, CODEX!, mock.port)
  const app = await App.launch({ sandbox: sb, scenario: { lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada', agent: 'codex' }] } } })
  try {
    const projectId = await app.openProject(repo)
    await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt' })
    const ready = await app.waitFor(async () => (await app.invoke('fleet:state', projectId)).ready, { timeout: 120_000, label: 'Ready card' }).catch(async (e) => {
      for (const m of Object.values((await app.invoke('fleet:state', projectId)).members) as any[])
        console.log(`--- ${m.name} (${await app.status(m.id)})\n${await app.invoke('pty:tail', m.id, 3000)}\nprompt: ${JSON.stringify(await app.invoke('pty:prompt', m.id))}`)
      throw e
    })
    assert.deepEqual(ready.files, ['a.txt'])
    const s = await app.invoke('fleet:state', projectId)
    const ada = Object.values(s.members).find((m: any) => m.name === 'Ada') as any
    assert.equal(ada.agentId, 'codex')
    assert.match(ada.report ?? '', /Wrote a\.txt/)
    // the fleet's tools reached the model through Codex's MCP client (authenticated by the env token),
    // found by tool search as a model in Codex does, and ran without asking anyone
    assert.ok(mock.requests.some((r) => r.found.includes('mcp__fleet/fleet_report')), `found: ${JSON.stringify(mock.requests.map((r) => r.found))}`)
    assert.equal((await app.invoke('fleet:mergeReady', projectId)).ok, true)
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'Codex was here\n')
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-codex-team.png')).catch(() => {})
    await app.close()
    await mock.close()
    stopCodexDaemons(sb)
  }
})
