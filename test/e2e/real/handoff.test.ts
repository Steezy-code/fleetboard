// Real Claude Code: a console's session is summarized by `claude -p` and the brief is typed into a
// new console, which then knows the work. Manual run, skipped unless FLEETBOARD_REAL_CLAUDE_CONFIG is set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'

const CONFIG = process.env.FLEETBOARD_REAL_CLAUDE_CONFIG

test('real: handoff carries the work over to a new console', { skip: !CONFIG, timeout: 6 * 60_000 }, async () => {
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  const config = path.join(sb.dir, 'claude-config')
  fs.cpSync(CONFIG!, config, { recursive: true, filter: (src) => !/\/(projects|file-history|todos|shell-snapshots|statsig|backups)(\/|$)/.test(src) })
  const cfgFile = path.join(config, '.claude.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.projects = { [repo]: { hasTrustDialogAccepted: true } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const app = await App.launch({ sandbox: sb, realClaudeConfig: config })
  const answerStartup = async () => {
    const t = await app.texts('.inbox-card.approval')
    if (t.some((x) => /auto mode your default/i.test(x))) await app.click('.inbox-card.approval .ic-actions button', 'No, keep manual mode').catch(() => {})
  }
  const tell = async (id: string, text: string) => {
    const done = app.invoke('pty:deliver', id, text)
    while ((await Promise.race([done, new Promise((r) => setTimeout(() => r('wait'), 1000))])) === 'wait') await answerStartup()
    assert.equal(await done, true)
    await app.waitStatus(id, 'working', 60_000).catch(() => {})
    await app.waitStatus(id, 'idle', 120_000)
  }
  try {
    await app.openProject(repo)
    const [from] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' }) as string[])
    await app.waitStatus(from, 'idle', 60_000)
    await tell(from, 'We are naming the new module "zephyrine-parser" and it must support UTF-16. Just acknowledge with one short sentence; do not use tools.')
    const [to] = await app.eval((id) => (window as any).__fleetboard.handoff({ fromIds: [id], toAgentId: 'claude' }), from)
    // the brief is typed in once the new console is ready; it then answers from it
    await app.waitFor(async () => /taking over/i.test(String(await app.invoke('pty:tail', to, 6000))), { timeout: 180_000, label: 'brief delivered' })
    await app.waitStatus(to, 'idle', 180_000)
    await tell(to, 'What is the new module called, and which encoding must it support? Answer in one line, no tools.')
    const screen = String(await app.invoke('pty:tail', to, 3000))
    assert.match(screen, /zephyrine-parser/i)
    assert.match(screen, /UTF-16/i)
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-handoff.png')).catch(() => {})
    await app.close()
  }
})
