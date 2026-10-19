// The real Codex CLI (against a local mock of the model API): two consoles in one project, the app
// restarted, each resumes its own session. Codex picks its own session ids; the app finds each
// console's after its first turn. Manual run, skipped unless FLEETBOARD_REAL_CODEX is the codex binary
// (FLEETBOARD_CODEX_CATALOG: an optional model catalog JSON for the mock model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'
import { startMockResponses } from '../../support/mock-responses'

const CODEX = process.env.FLEETBOARD_REAL_CODEX

test('real Codex: each console resumes its own session after a restart', { skip: !CODEX, timeout: 6 * 60_000 }, async () => {
  const mock = await startMockResponses()
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  fs.writeFileSync(path.join(sb.bin, 'codex'), `#!/bin/sh\nexec "${CODEX}" "$@"\n`, { mode: 0o755 })
  fs.appendFileSync(path.join(sb.home, '.bash_profile'), 'export MOCK_KEY=mock\n')
  fs.mkdirSync(path.join(sb.home, '.codex'), { recursive: true })
  fs.writeFileSync(
    path.join(sb.home, '.codex', 'config.toml'),
    [
      'model = "mock-model"',
      'model_provider = "mock"',
      ...(process.env.FLEETBOARD_CODEX_CATALOG ? [`model_catalog_json = ${JSON.stringify(process.env.FLEETBOARD_CODEX_CATALOG)}`] : []),
      'check_for_update_on_startup = false',
      '[model_providers.mock]',
      'name = "Mock"',
      `base_url = "http://127.0.0.1:${mock.port}/v1"`,
      'wire_api = "responses"',
      'env_key = "MOCK_KEY"',
      `[projects.${JSON.stringify(repo)}]`,
      'trust_level = "trusted"',
      '[tui]',
      'screen_reader_detection_done = true'
    ].join('\n') + '\n'
  )
  let app = await App.launch({ sandbox: sb })
  const nodeData = (id: string) => app.eval((id) => (window as any).__fleetboard.useApp.getState().project.workspaces.flatMap((w: any) => w.nodes).find((n: any) => n.id === id)?.data, id)
  const tell = async (id: string, text: string) => {
    assert.equal(await app.invoke('pty:deliver', id, text), true)
    await app.waitStatus(id, 'working', 30_000).catch(() => {})
    await app.waitStatus(id, 'idle', 60_000)
  }
  try {
    await app.openProject(repo)
    const [a, b] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'codex', count: 2 }) as string[])
    for (const id of [a, b]) await app.waitStatus(id, 'idle', 60_000)
    await tell(a, 'pelican')
    await tell(b, 'lighthouse')
    const ids = await app.waitFor(
      async () => {
        const s = [(await nodeData(a)).sessionId, (await nodeData(b)).sessionId]
        return s[0] && s[1] ? s : null
      },
      { label: 'both sessions found', timeout: 20_000 }
    )
    assert.notEqual(ids[0], ids[1])
    assert.equal(await app.quitLikeUser(), true)

    app = await App.launch({ sandbox: sb })
    await app.openProject(repo)
    await app.waitFor(async () => (await app.texts('.resume-banner')).join(''), { label: 'resume banner' })
    await app.click('.resume-banner button', 'Yes')
    for (const id of [a, b]) await app.waitStatus(id, 'idle', 60_000)
    const before = mock.requests.length
    await tell(a, 'which word')
    await tell(b, 'which word')
    // (Codex also asks the model for a title for the session: not part of the conversation)
    const asked = mock.requests.slice(before).filter((r) => r.last === 'which word')
    assert.deepEqual(asked.map((r) => r.first).sort(), ['lighthouse', 'pelican'], `the model saw: ${JSON.stringify(asked)}`)
    assert.match(String(await app.invoke('pty:tail', a, 4000)), /Conversation started with: pelican/)
    assert.match(String(await app.invoke('pty:tail', b, 4000)), /Conversation started with: lighthouse/)
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-codex-sessions.png')).catch(() => {})
    await app.close()
    await mock.close()
    // Codex starts a background app-server of its own; it would outlive the test (and hold its pipes)
    try {
      execFileSync('pkill', ['-f', `${sb.home}/.codex/`])
    } catch {
      /* none left */
    }
  }
})
