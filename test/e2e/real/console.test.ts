// Real Claude Code in a console: hooks reach the app, a real permission dialog reaches the Inbox, and
// answering from the Inbox moves its cursor and confirms. Manual run, skipped unless
// FLEETBOARD_REAL_CLAUDE_CONFIG points at an onboarded Claude config dir (it is copied, not changed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'

const CONFIG = process.env.FLEETBOARD_REAL_CLAUDE_CONFIG

test('real: permission dialogs answered from the Inbox (allow, then deny)', { skip: !CONFIG, timeout: 6 * 60_000 }, async () => {
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  const config = path.join(sb.dir, 'claude-config')
  fs.cpSync(CONFIG!, config, { recursive: true, filter: (src) => !/\/(projects|file-history|todos|shell-snapshots|statsig|backups)(\/|$)/.test(src) })
  const cfgFile = path.join(config, '.claude.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.projects = { [repo]: { hasTrustDialogAccepted: true } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  // recent Claude Code starts in auto mode; this user wants to be asked
  const settingsFile = path.join(config, 'settings.json')
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, permissions: { ...settings.permissions, defaultMode: 'default' } }))
  const app = await App.launch({ sandbox: sb, realClaudeConfig: config })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    // SessionStart arrives through the hook server: the console is "idle", not stuck in "starting"
    await app.waitStatus(id, 'idle', 60_000)
    // how the app types messages it sends by itself (first prompts, handoffs, team messages)
    const send = async (text: string) => assert.equal(await app.invoke('pty:deliver', id, text), true)

    // delivered by the app: it waits while Claude asks its startup question (auto mode as the default?)
    const delivered = app.invoke('pty:deliver', id, 'Run the shell command `touch allowed.txt` with the Bash tool. Nothing else.')
    const startup = await app
      .waitFor(async () => (await app.texts('.it-card[data-kind="approval"]')).find((t) => /auto mode your default/i.test(t)), { timeout: 8000, label: 'startup question' })
      .catch(() => null)
    if (startup) {
      assert.equal(fs.existsSync(path.join(repo, 'allowed.txt')), false)
      await app.click('.it-card[data-kind="approval"] .it-actions button', 'No, keep manual mode')
    }
    assert.equal(await delivered, true)
    await app.waitFor(async () => (await app.texts('.it-card[data-kind="approval"]')).some((t) => /touch allowed\.txt/.test(t)), { timeout: 90_000, label: 'permission card' })
    // the hook reports the dialog a moment before Claude draws it: the card fills in on the next refresh
    const card = await app.waitFor(async () => (await app.texts('.it-card[data-kind="approval"]')).find((t) => /touch allowed\.txt/.test(t)), { label: 'Inbox card' })
    assert.match(card, /Allow once/)
    await app.click('.it-card[data-kind="approval"] .it-actions button', 'Allow once')
    await app.waitFor(() => fs.existsSync(path.join(repo, 'allowed.txt')), { timeout: 60_000, label: 'command ran after Allow once' })
    await app.waitStatus(id, 'idle', 90_000)

    await send('Run the shell command `touch denied.txt` with the Bash tool. Nothing else.')
    await app.waitStatus(id, 'needs-you', 90_000)
    await app.waitFor(async () => (await app.texts('.it-card[data-kind="approval"]')).some((t) => /touch denied\.txt/.test(t)), { label: 'second card' })
    await app.click('.it-card[data-kind="approval"] .it-actions button', 'Deny')
    await app.waitStatus(id, 'idle', 90_000)
    assert.equal(fs.existsSync(path.join(repo, 'denied.txt')), false, 'Deny (the last option, several arrow presses away) was chosen')
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-console.png')).catch(() => {})
    await app.close()
  }
})
