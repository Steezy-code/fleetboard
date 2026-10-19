// The real Codex CLI (against a local mock of the model API) asks to run commands; the Inbox card shows
// the command, and answering it there approves or refuses in Codex's own dialog. Manual run, skipped
// unless FLEETBOARD_REAL_CODEX is the codex binary and FLEETBOARD_CODEX_CATALOG a model catalog that lists
// mock-model (without one Codex offers the model no tools to ask with).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'
import { startMockResponses } from '../../support/mock-responses'
import { setupCodex, stopCodexDaemons } from './codex-setup'

const CODEX = process.env.FLEETBOARD_REAL_CODEX
const CATALOG = process.env.FLEETBOARD_CODEX_CATALOG

test('real Codex: command approvals answered from the Inbox (allow, then refuse)', { skip: !(CODEX && CATALOG), timeout: 5 * 60_000 }, async () => {
  const mock = await startMockResponses()
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  setupCodex(sb, repo, CODEX!, mock.port)
  const app = await App.launch({ sandbox: sb })
  const card = (re: RegExp) => app.waitFor(async () => (await app.texts('.it-card[data-kind="approval"]')).find((t) => re.test(t)), { timeout: 60_000, label: `Inbox card ${re}` })
  try {
    await app.openProject(repo)
    const [id] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'codex' }) as string[])
    await app.waitStatus(id, 'idle', 60_000)

    assert.equal(await app.invoke('pty:deliver', id, 'please run the command `touch allowed.txt`'), true)
    await app.waitStatus(id, 'needs-you', 60_000)
    const first = await card(/touch allowed\.txt/)
    assert.match(first, /\$ touch allowed\.txt/, 'the card shows the command')
    assert.deepEqual(await app.texts('.it-card[data-kind="approval"] .it-actions button'), ['Allow once', 'Always allow `touch allowed.txt`', 'No, and tell Codex what to do differently'])
    await app.click('.it-card[data-kind="approval"] .it-actions button', 'Allow once')
    await app.waitFor(() => fs.existsSync(path.join(repo, 'allowed.txt')), { timeout: 30_000, label: 'the command ran' })
    await app.waitStatus(id, 'idle', 60_000)

    assert.equal(await app.invoke('pty:deliver', id, 'please run the command `touch refused.txt`'), true)
    await app.waitStatus(id, 'needs-you', 60_000)
    await card(/touch refused\.txt/)
    await app.click('.it-card[data-kind="approval"] .it-actions button', 'No, and tell Codex what to do differently')
    await app.waitStatus(id, 'idle', 60_000)
    await new Promise((r) => setTimeout(r, 2000))
    assert.equal(fs.existsSync(path.join(repo, 'refused.txt')), false, 'the last option, two arrow presses away, was chosen')
    assert.equal((await app.texts('.it-card[data-kind="approval"]')).length, 0, 'no card left')
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-codex-console.png')).catch(() => {})
    await app.close()
    await mock.close()
    stopCodexDaemons(sb)
  }
})
