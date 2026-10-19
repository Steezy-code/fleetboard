// Real Claude Code: two consoles in one project, the app restarted, each resumes its own conversation.
// Manual run, skipped unless FLEETBOARD_REAL_CLAUDE_CONFIG points at an onboarded Claude config dir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from '../harness'

const CONFIG = process.env.FLEETBOARD_REAL_CLAUDE_CONFIG

test('real: each console resumes its own conversation after a restart', { skip: !CONFIG, timeout: 8 * 60_000 }, async () => {
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb)
  const config = path.join(sb.dir, 'claude-config')
  fs.cpSync(CONFIG!, config, { recursive: true, filter: (src) => !/\/(projects|file-history|todos|shell-snapshots|statsig|backups)(\/|$)/.test(src) })
  const cfgFile = path.join(config, '.claude.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.projects = { [repo]: { hasTrustDialogAccepted: true } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))

  let app = await App.launch({ sandbox: sb, realClaudeConfig: config })
  // a startup question (auto mode as the default?) is answered from the Inbox; delivered messages wait for it
  const answerStartup = async () => {
    const t = await app.texts('.it-card[data-kind="approval"]')
    if (t.some((x) => /auto mode your default/i.test(x))) await app.click('.it-card[data-kind="approval"] .it-actions button', 'No, keep manual mode').catch(() => {})
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
    const [a, b] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', count: 2 }) as string[])
    for (const id of [a, b]) await app.waitStatus(id, 'idle', 60_000)
    await tell(a, 'Remember this word for later: pelican. Reply only with OK.')
    await tell(b, 'Remember this word for later: lighthouse. Reply only with OK.')
    assert.equal(await app.quitLikeUser(), true)

    app = await App.launch({ sandbox: sb, realClaudeConfig: config })
    await app.openProject(repo)
    await app.waitFor(async () => (await app.texts('.resume-banner')).join(''), { label: 'resume banner' })
    await app.click('.resume-banner button', 'Yes')
    for (const id of [a, b]) await app.waitStatus(id, 'idle', 90_000)
    for (const id of [a, b]) await tell(id, 'Which word did I ask you to remember? Reply with just that word, in capitals.')
    const screenA = String(await app.invoke('pty:tail', a, 6000))
    const screenB = String(await app.invoke('pty:tail', b, 6000))
    assert.match(screenA, /PELICAN/)
    assert.doesNotMatch(screenA, /lighthouse/i, "a did not resume b's conversation")
    assert.match(screenB, /LIGHTHOUSE/)
    assert.doesNotMatch(screenB, /pelican/i)
  } finally {
    if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'real-sessions.png')).catch(() => {})
    await app.close()
  }
})
