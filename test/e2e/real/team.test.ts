// A real team with the real Claude Code: manual stress run, skipped unless
// FLEETBOARD_REAL_CLAUDE_CONFIG points at an onboarded Claude config dir (it is copied, not changed).
//   FLEETBOARD_REAL_CLAUDE_CONFIG=~/.claude npm run test:e2e -- --test-name-pattern=real
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { App, git, makeRepo, makeSandbox } from '../harness'

const CONFIG = process.env.FLEETBOARD_REAL_CLAUDE_CONFIG
const GOAL =
  process.env.FLEETBOARD_REAL_GOAL ??
  'Add a slugify(text) function to src/strings.js (lowercase, words joined by "-", only a-z0-9) and a truncate(text, max) function that adds "…" when it cuts. Each needs tests in test/strings.test.js. npm test must pass.'

test('real: a team builds a small feature end to end', { skip: !CONFIG, timeout: 30 * 60_000 }, async () => {
  const sb = makeSandbox({ fake: false })
  const repo = makeRepo(sb, 'strings', {
    'package.json': JSON.stringify({ name: 'strings', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'src/strings.js': 'export function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1)\n}\n',
    'test/strings.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { capitalize } from '../src/strings.js'\n\ntest('capitalize', () => {\n  assert.equal(capitalize('hello'), 'Hello')\n})\n"
  })
  // a copy of the user's onboarded config, in which they trust this repo
  const config = path.join(sb.dir, 'claude-config')
  fs.cpSync(CONFIG!, config, { recursive: true, filter: (src) => !/\/(projects|file-history|todos|shell-snapshots|statsig|backups)(\/|$)/.test(src) })
  const cfgFile = path.join(config, '.claude.json')
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}
  cfg.projects = { [repo]: { hasTrustDialogAccepted: true } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))

  const app = await App.launch({ sandbox: sb, realClaudeConfig: config })
  const shots = process.env.E2E_SHOTS
  const started = Date.now()
  const say = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)
  try {
    const projectId = await app.openProject(repo)
    await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: GOAL })
    say(`lead started: ${GOAL}`)
    let last = ''
    let ready: any = null
    for (let i = 0; !ready && Date.now() - started < 25 * 60_000; i++) {
      await new Promise((r) => setTimeout(r, 10_000))
      const s = await app.invoke('fleet:state', projectId)
      const statuses = await app.eval(() => (window as any).__fleetboard.useApp.getState().statuses)
      const members = Object.values(s.members as Record<string, any>).map((m) => `${m.name}(${m.role}):${m.status}/${statuses[m.id] ?? '-'}`)
      const line = `members ${members.join(' ')} | tasks ${s.tasks.map((t: any) => t.status).join(',')} | asks ${s.asks.filter((a: any) => !a.answer).length}`
      if (line !== last) say(line)
      last = line
      // anything waiting on the user that the app did not handle by itself
      for (const m of Object.values(s.members as Record<string, any>)) {
        if (statuses[m.id] !== 'needs-you') continue
        const p = await app.invoke('pty:prompt', m.id)
        say(`${m.name} needs you: ${JSON.stringify(p?.question ?? p?.lines?.slice(-3))} options=${JSON.stringify(p?.options?.map((o: any) => o.label))}`)
        // answer like an attentive user: the Inbox card's primary button (allow once / trust / continue)
        // the tray shows one item at a time: step through it to this member's card
        const clicked = await app.eval(async (name) => {
          for (let k = 0; k < 12; k++) {
            const card = document.querySelector<HTMLElement>('.it-card[data-kind="approval"]')
            if (card?.querySelector('.it-title b')?.textContent === name) {
              const btn = card!.querySelector<HTMLButtonElement>('.it-actions .btn.primary')
              btn?.click()
              return btn?.textContent ?? null
            }
            const next = document.querySelector<HTMLButtonElement>('.inbox-tray button[title^="Next"]')
            if (!next) return null
            next.click()
            await new Promise((r) => setTimeout(r, 50))
          }
          return null
        }, m.name)
        say(`  → Inbox: ${clicked ?? 'no card with an allow button'}`)
      }
      if (shots && i % 6 === 0) await app.screenshot(path.join(shots, `real-${String(i).padStart(3, '0')}.png`))
      ready = s.ready
    }
    assert.ok(ready, 'the team finished')
    say(`READY: ${ready.commits} commits, files ${ready.files.join(', ')}\n${ready.summary}`)
    fs.writeFileSync(path.join(sb.dir, 'fleet-state.json'), JSON.stringify(await app.invoke('fleet:state', projectId), null, 2))
    const res = await app.invoke('fleet:mergeReady', projectId)
    assert.equal(res.ok, true, JSON.stringify(res))
    const out = execFileSync('npm', ['test'], { cwd: repo, encoding: 'utf8', env: Object.fromEntries(Object.entries({ ...process.env, HOME: sb.home }).filter(([k]) => !/^NODE_(TEST_CONTEXT|OPTIONS)$/.test(k))) })
    say(`npm test in the user's checkout after the merge:\n${out.split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('\n')}`)
    say(git(sb, repo, 'log', '--oneline', '-12'))
  } finally {
    if (shots) await app.screenshot(path.join(shots, 'real-final.png')).catch(() => {})
    say(`sandbox kept at ${sb.dir}`)
    await app.close()
  }
})
