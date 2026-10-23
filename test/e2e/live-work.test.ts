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
