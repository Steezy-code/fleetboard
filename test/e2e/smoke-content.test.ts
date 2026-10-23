// Panels, studios, drawers and tiles with real content (files with odd names, uncommitted changes, CLI
// usage logs, loops, memory cards, a running console) open without an error in the app window.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox } from './harness'

let app: App
let repo: string
let consoleId: string
const FIX = path.resolve(import.meta.dirname, '../fixtures/usage')

before(async () => {
  const sb = makeSandbox()
  repo = makeRepo(sb, 'repo', {
    'README.md': '# demo\n\nSee [notes](notes.md) and [[Ideas]].\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    'notes.md': '# Notes\n\n- [ ] todo\n- [x] done\n\n```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst x = 1\n```\n',
    'Ideas.md': '---\ntags: [x]\n---\n# Ideas\nBack to [[README]].\n',
    'src/app.ts': 'export const answer = 42\n',
    'src/über file.ts': 'export {}\n',
    'docs/guide.html': '<h1>Guide</h1><script>alert(1)</script>',
    'logo.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('latin1')
  })
  // uncommitted work of every kind
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const answer = 43\n')
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'new\n')
  fs.rmSync(path.join(repo, 'Ideas.md'))
  git(sb, repo, 'add', 'new file.txt')
  // the CLIs' own usage logs
  const put = (rel: string, file: string) => {
    fs.mkdirSync(path.dirname(path.join(sb.home, rel)), { recursive: true })
    fs.copyFileSync(path.join(FIX, file), path.join(sb.home, rel))
  }
  put('.claude/projects/-demo/a.jsonl', 'claude-session.jsonl')
  put('.codex/sessions/2026/10/19/rollout-x.jsonl', 'codex-rollout.jsonl')
  put('.gemini/tmp/demo/chats/session-x.jsonl', 'gemini-chat.jsonl')
  // a repo for the morning sweep
  fs.mkdirSync(path.join(sb.home, 'code'), { recursive: true })
  fs.cpSync(repo, path.join(sb.home, 'code', 'other'), { recursive: true })

  app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  await app.openProject(repo)
  consoleId = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
  await app.waitStatus(consoleId, 'idle')
  await app.invoke('pty:deliver', consoleId, 'hello there')
  await app.eval(() => {
    const s = (window as any).__fleetboard.useApp.getState()
    const now = Date.now()
    s.setProjectExtra('memory', [{ id: 'm1', scope: 'repo', category: 'Commands', title: 'Tests', body: 'npm test', createdAt: now, updatedAt: now }])
    s.setProjectExtra('loops', [
      {
        id: 'loop1',
        name: 'Keep going',
        instruction: 'continue',
        trigger: { kind: 'schedule', everyMin: 60 },
        target: { kind: 'all' },
        stop: { afterRuns: true, runs: 3, afterTime: false, minutes: 60, goal: false, goalKind: 'judge', command: 'npm test', judgeAgent: 'claude', goalText: '' },
        background: true,
        enabled: false,
        createdAt: now,
        startedAt: now,
        runs: 1
      }
    ])
  })
})

after(async () => {
  if (process.env.E2E_SHOTS) await app?.screenshot(path.join(process.env.E2E_SHOTS, 'smoke-content.png')).catch(() => {})
  await app?.close()
})

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
async function check(what: string, from: number) {
  await settle()
  assert.deepEqual(app.rendererErrors.slice(from), [], `${what}: errors in the app window`)
  assert.equal(await app.eval(() => document.querySelectorAll('.boundary').length), 0, `${what}: something could not be shown`)
}

const openings: [string, string, Record<string, unknown>?][] = [
  ['panel', 'code', { path: 'src/app.ts' }],
  ['panel', 'code', { path: 'src/über file.ts' }],
  ['panel', 'markdown', { path: 'notes.md' }],
  ['panel', 'markdown', { path: 'README.md' }],
  ['panel', 'documents'],
  ['panel', 'diagrams'],
  ['panel', 'loops'],
  ['panel', 'memory'],
  ['panel', 'missionMap'],
  ['panel', 'composer'],
  ['panel', 'presets'],
  ['panel', 'skills'],
  ['panel', 'settings'],
  ['panel', 'sweep'],
  ['drawer', 'usage'],
  ['drawer', 'git'],
  ['drawer', 'accounts'],
  ['drawer', 'chat'],
  ['drawer', 'orchestrator']
]

for (const [kind, name, props] of openings) {
  test(`${kind} ${name}${props ? ` ${JSON.stringify(props)}` : ''} with content`, async () => {
    const n = app.rendererErrors.length
    await app.eval(
      ({ kind, name, props }) => {
        const s = (window as any).__fleetboard.useApp.getState()
        kind === 'panel' ? s.openPanel(name, props) : s.openDrawer(name, props)
      },
      { kind, name, props }
    )
    await check(`${kind} ${name}`, n)
    await app.eval((kind) => {
      const s = (window as any).__fleetboard.useApp.getState()
      kind === 'panel' ? s.closePanel() : s.closeDrawer()
    }, kind)
  })
}

test('the handoff panel from a console with a conversation', async () => {
  const n = app.rendererErrors.length
  await app.eval((id) => (window as any).__fleetboard.useApp.getState().openPanel('handoff', { from: [id] }), consoleId)
  await check('handoff', n)
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
})

test('tiles showing files', async () => {
  const n = app.rendererErrors.length
  for (const data of [{ path: path.join(repo, 'src/app.ts') }, { path: path.join(repo, 'notes.md') }, { path: path.join(repo, 'docs/guide.html') }, { path: path.join(repo, 'missing.ts') }]) {
    await app.eval((data) => (window as any).__fleetboard.useApp.getState().addNode({ type: 'file', x: 0, y: 0, data }), data)
  }
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().addNode({ type: 'doc', x: 0, y: 0, data: { path: p } }), path.join(repo, 'README.md'))
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().addNode({ type: 'image', x: 0, y: 0, data: { path: p } }), path.join(repo, 'logo.png'))
  await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'git', x: 0, y: 0 }))
  await check('file, doc, image and git tiles', n)
})

test('a tile of a type this build does not know says so, and can be removed', async () => {
  // A board written by a newer Fleetboard, or edited by hand. NodeFrame used to return null for an
  // unknown type: the tile was invisible, unselectable and undeletable, while still taking up its
  // place in the board file — so it came back, still invisible, on every load.
  await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'hologram', x: 60, y: 1400, w: 360, h: 180 }))
  const text = await app.waitFor(async () => (await app.texts('.node-unknown'))[0] ?? null, { label: 'the placeholder' })
  assert.match(text, /unknown tile/i)
  assert.match(text, /hologram/, 'it names the type, so the board file makes sense')
  await app.click('.node-unknown button', 'Remove it')
  await app.waitFor(() => app.eval(() => !document.querySelector('.node-unknown')), { label: 'removed' })
  assert.deepEqual(app.rendererErrors, [])
})
