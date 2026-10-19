// Flows that combine consoles, headless CLI runs and the board: handoff and the morning sweep.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox, type Sandbox } from './harness'

let app: App
let sb: Sandbox
let repo: string

before(async () => {
  sb = makeSandbox()
  repo = makeRepo(sb)
  // repos for the sweep under ~/code: one with work in progress, one clean
  const code = path.join(sb.home, 'code')
  const alpha = makeRepo(sb, 'home/code/alpha', { 'README.md': '# alpha\n', 'PLAN.md': '- [x] start\n- [ ] add the export button\n' })
  fs.writeFileSync(path.join(alpha, 'README.md'), '# alpha, edited\n')
  fs.writeFileSync(path.join(alpha, 'new file.txt'), 'wip\n')
  makeRepo(sb, 'home/code/beta')
  assert.ok(fs.existsSync(path.join(code, 'alpha', '.git')))
  app = await App.launch({
    sandbox: sb,
    scenario: {
      solo: [{ match: 'build the parser', workMs: 300, reply: 'Parser half done; tokenizer.ts written, tests failing on unicode.' }],
      print: [{ match: 'handoff brief', reply: '**Goal** Finish the parser. **Done so far** tokenizer.ts. **Left to do** fix unicode tests.' }]
    }
  })
  await app.openProject(repo)
})

after(async () => {
  await app?.close()
})

test('handoff: a session is summarized by the CLI and the brief is typed into a new agent', async () => {
  const from = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
  await app.waitStatus(from, 'idle')
  await app.eval((id) => (window as any).__fleetboard.sendToConsole(id, 'build the parser'), from)
  await app.waitFor(async () => /Parser half done/.test(await app.invoke('pty:tail', from, 4000)), { label: 'source worked' })

  const receivers: string[] = await app.eval((id) => (window as any).__fleetboard.handoff({ fromIds: [id], toAgentId: 'claude' }), from)
  assert.equal(receivers.length, 1)
  // the brief was written from the source's real transcript
  const brief = app.fakeLog((e) => e.event === 'print').at(-1)
  assert.match(brief.prompt, /Parser half done/)
  assert.ok(brief.args.includes('--allowedTools'), 'summarizing is read-only')
  // and typed into the new console once it was ready
  const got = await app.waitFor(() => app.fakeLog((e) => e.event === 'prompt' && e.pid !== app.fakeLog((x) => x.event === 'prompt' && /build the parser/.test(x.prompt))[0]?.pid && /taking over a task/.test(e.prompt))[0], { label: 'brief delivered', timeout: 20_000 })
  assert.match(got.prompt, /\*\*Goal\*\* Finish the parser/)
  const wired = await app.eval(({ a, b }) => (window as any).__fleetboard.useApp.getState().project.workspaces[0].wires.some((w: any) => w.from === a && w.to === b), { a: from, b: receivers[0] })
  assert.equal(wired, true, 'source is wired to the receiver')
})

test('morning sweep: finds repos under ~/code and reports their state without changing them', async () => {
  const alpha = path.join(sb.home, 'code', 'alpha')
  const before = git(sb, alpha, 'status', '--porcelain')
  const res = await app.invoke('sweep:run', {})
  assert.ok(!res.error, res.error)
  const byName = Object.fromEntries(res.repos.map((r: any) => [r.name, r]))
  assert.ok(byName.alpha && byName.beta, `found ${res.repos.map((r: any) => r.name).join(', ')}`)
  assert.equal(byName.alpha.uncommitted, 1)
  assert.equal(byName.alpha.untracked, 1)
  assert.deepEqual(byName.alpha.plan, { file: 'PLAN.md', item: 'add the export button' })
  assert.equal(byName.beta.uncommitted + byName.beta.untracked, 0)
  assert.ok(byName.alpha.score > byName.beta.score, 'work in progress ranks first')
  assert.equal(git(sb, alpha, 'status', '--porcelain'), before, 'read-only')
})
