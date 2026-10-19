// A team with a real Gemini CLI worker (against a local mock of the Gemini API that acts like a
// worker): it reaches the fleet tools through the settings of its own Gemini home, writes its file in
// its worktree (trusted because the project is) and reports; the work is merged into the checkout.
// Manual run, skipped unless FLEETBOARD_REAL_GEMINI is the gemini binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'
import { startMockGemini } from '../../support/mock-responses'
import { setupGemini } from './gemini-setup'

const GEMINI = process.env.FLEETBOARD_REAL_GEMINI

test('real Gemini as a team worker: brief, fleet tools over MCP, report, merge', { skip: !GEMINI, timeout: 5 * 60_000 }, async () => {
  const mock = await startMockGemini()
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  setupGemini(sb, repo, GEMINI!, mock.port)
  const app = await App.launch({ sandbox: sb, scenario: { lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Gem', agent: 'gemini' }] } } })
  try {
    const projectId = await app.openProject(repo)
    await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt' })
    const ready = await app.waitFor(async () => (await app.invoke('fleet:state', projectId)).ready, { timeout: 120_000, label: 'Ready card' }).catch(async (e) => {
      for (const m of Object.values((await app.invoke('fleet:state', projectId)).members) as any[])
        console.log(`--- ${m.name} (${await app.status(m.id)})\n${await app.invoke('pty:tail', m.id, 3000)}`)
      throw e
    })
    assert.deepEqual(ready.files, ['a.txt'])
    const gem = Object.values((await app.invoke('fleet:state', projectId)).members).find((m: any) => m.name === 'Gem') as any
    assert.equal(gem.agentId, 'gemini')
    assert.match(gem.report ?? '', /Wrote a\.txt/)
    assert.ok(mock.requests.some((r) => r.tools.includes('mcp_fleet_fleet_report')), `tools: ${JSON.stringify(mock.requests.at(-1)?.tools)}`)
    assert.ok(!fs.readFileSync(path.join(sb.home, '.gemini', 'settings.json'), 'utf8').includes('fleet'), "the user's own Gemini settings are untouched")
    assert.equal((await app.invoke('fleet:mergeReady', projectId)).ok, true)
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'Gemini was here\n')
    assert.equal(fs.existsSync(path.join(sb.fbHome, 'gemini-homes', gem.id)), false, "the worker's Gemini home is gone with it")
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-gemini-team.png')).catch(() => {})
    await app.close()
    await mock.close()
  }
})
