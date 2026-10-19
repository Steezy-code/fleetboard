// Teams end to end: the real app, its fleet MCP server, git worktrees and the Inbox, with the scripted
// fake claude playing Lead, workers and reviewer.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox } from './harness'

let app: App | null = null
afterEach(async (t) => {
  if (!app) return
  if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, `${t.name.replace(/\W+/g, '-')}.png`))
  await app.close()
  app = null
})

async function team(scenario: object, goal = 'add the files', files?: Record<string, string>) {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'repo', files)
  app = await App.launch({ sandbox: sb, scenario })
  const projectId = await app.openProject(repo)
  const lead = await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal })
  return { sb, repo, projectId, lead, app }
}

const fleet = (projectId: string) => app!.invoke('fleet:state', projectId)
const waitReady = (projectId: string, timeout = 60_000) => app!.waitFor(async () => (await fleet(projectId)).ready, { timeout, label: 'Ready card' })
const toolCalls = (tool: string) => app!.fakeLog((e) => e.event === 'tool' && e.tool === tool)

const TWO_WORKERS = {
  lead: {
    tasks: [
      { task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' },
      { task: 'Write b.txt', owns: ['b.txt'], done_when: 'b.txt exists', name: 'Bo' }
    ],
    review: true
  }
}

test('a goal goes plan → workers in worktrees → merge → review → Ready → merged into the checkout', async () => {
  const { sb, repo, projectId } = await team(TWO_WORKERS)
  const ready = await waitReady(projectId)
  assert.deepEqual([...ready.files].sort(), ['a.txt', 'b.txt'])
  assert.ok(ready.commits >= 2, `commits: ${ready.commits}`)

  const s = await fleet(projectId)
  const members = Object.values(s.members) as any[]
  const workers = members.filter((m) => m.role === 'worker')
  assert.deepEqual(workers.map((w) => w.name).sort(), ['Ada', 'Bo'])
  for (const w of workers) {
    assert.ok(w.cwd.includes(`${path.sep}worktrees${path.sep}`), 'each worker has its own worktree')
    assert.equal(w.status, 'merged')
  }
  assert.ok(members.some((m) => m.role === 'reviewer'), 'a reviewer checked the work')
  assert.deepEqual(
    s.tasks.map((t: any) => t.status),
    ['done', 'done']
  )
  // the user's checkout is untouched until they merge
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false)

  const res = await app!.invoke('fleet:mergeReady', projectId)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'Ada was here\n')
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'Bo was here\n')
  assert.equal(git(sb, repo, 'status', '--porcelain'), '', 'checkout is clean after the merge')
  assert.equal(git(sb, repo, 'worktree', 'list').split('\n').length, 1, 'all worktrees removed')
  assert.equal(git(sb, repo, 'branch', '--list', 'fleet/*'), '', 'team branches deleted')
  const after = await fleet(projectId)
  assert.equal(after.ready, null)
  assert.ok(Object.values(after.members).every((m: any) => m.status === 'closed'))
})

test('workers show on the plan when the lead names the task by number, by other words, or not at all', async () => {
  const { projectId } = await team({
    lead: {
      tasks: [
        { title: 'Greeting file', task: 'Put a greeting into the file a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada', ref: '1' },
        { title: 'Release notes in b.txt', task: 'Write the release notes, in b.txt', owns: ['b.txt'], done_when: 'b.txt exists', name: 'Bo', ref: null },
        { title: 'Changelog entry', task: 'Write c.txt', owns: ['c.txt'], done_when: 'c.txt exists', name: 'Cy', ref: null }
      ]
    }
  })
  await waitReady(projectId)
  const s = await fleet(projectId)
  const owner = (id: string) => (s.members[id] as any)?.name
  assert.deepEqual(
    s.tasks.map((t: any) => [t.title, owner(t.owner), t.status]),
    [
      ['Greeting file', 'Ada', 'done'],
      ['Release notes in b.txt', 'Bo', 'done'],
      ['Changelog entry', undefined, 'todo']
    ],
    'linked by number, by its words; "Write c.txt" names no task, so it is not guessed'
  )
  const spawns = toolCalls('fleet_spawn_worker').map((e) => e.result as string)
  assert.match(spawns[0], /On the plan: "Greeting file"/)
  assert.match(spawns[2], /not linked to a plan task: call fleet_update_task/, 'the lead is told how to fix it')
})

test("merging the team's work keeps the user's uncommitted changes", async () => {
  const { sb, repo, projectId } = await team(TWO_WORKERS, 'add the files', { 'README.md': '# demo\n', 'notes.md': 'mine\n' })
  fs.writeFileSync(path.join(repo, 'notes.md'), 'mine, edited while the team worked\n')
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n')
  await waitReady(projectId)
  const res = await app!.invoke('fleet:mergeReady', projectId)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(fs.readFileSync(path.join(repo, 'notes.md'), 'utf8'), 'mine, edited while the team worked\n')
  assert.equal(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8'), 'untracked\n')
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')))
  assert.match(git(sb, repo, 'status', '--porcelain'), /M notes\.md/)
})

test('a merge that would overwrite local work is refused and leaves the checkout and Ready card as they were', async () => {
  const { sb, repo, projectId } = await team(TWO_WORKERS)
  await waitReady(projectId)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'the user made this file too\n')
  const head = git(sb, repo, 'rev-parse', 'HEAD')
  const res = await app!.invoke('fleet:mergeReady', projectId)
  assert.equal(res.ok, false)
  assert.match(res.error, /a\.txt/)
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'the user made this file too\n')
  assert.equal(git(sb, repo, 'rev-parse', 'HEAD'), head)
  assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false)
  assert.ok((await fleet(projectId)).ready, 'the Ready card stays so the user can merge after cleaning up')
})

test('two workers editing the same file: the second merge reports the conflict and the lead branch stays clean', async () => {
  const { projectId } = await team({
    lead: {
      tasks: [
        { task: 'Edit shared.txt one way', owns: ['shared.txt'], done_when: 'done', name: 'Ada' },
        { task: 'Edit shared.txt another way', owns: ['shared.txt'], done_when: 'done', name: 'Bo' }
      ]
    },
    workers: { Ada: { files: { 'shared.txt': 'Ada version\n' } }, Bo: { files: { 'shared.txt': 'Bo version\n' }, delayMs: 1500 } }
  })
  const ready = await waitReady(projectId)
  const merges = app!.fakeLog((e) => e.event === 'merged')
  assert.deepEqual(
    merges.map((m) => [m.worker, m.ok]),
    [
      ['Ada', true],
      ['Bo', false]
    ]
  )
  assert.match(merges[1].text, /conflicts in: shared\.txt/)
  const lead = Object.values((await fleet(projectId)).members).find((m: any) => m.role === 'lead') as any
  assert.equal(fs.existsSync(path.join(lead.cwd, '.git')) && fs.readFileSync(path.join(lead.cwd, '.git'), 'utf8').length > 0, true)
  assert.equal(fs.readFileSync(path.join(lead.cwd, 'shared.txt'), 'utf8'), 'Ada version\n', 'merge was aborted, not left half-done')
  assert.deepEqual(ready.files, ['shared.txt'])
})

test('a worker whose console dies is reported to the lead, which carries on', async () => {
  const { projectId } = await team({ ...TWO_WORKERS, lead: { ...TWO_WORKERS.lead, review: false, waitMs: 45_000 }, workers: { Bo: { crash: 3, delayMs: 500 } } })
  const ready = await waitReady(projectId, 40_000)
  assert.deepEqual(ready.files, ['a.txt'])
  const waits = app!.fakeLog((e) => e.event === 'wait-result').map((e) => e.text)
  assert.ok(
    waits.some((t) => /Bo reported: \(blocked\)/.test(t) && /exited/.test(t)),
    `the lead heard about it: ${JSON.stringify(waits)}`
  )
  assert.equal(app!.fakeLog((e) => e.event === 'gave-up').length, 0, 'the lead did not have to time out')
})

test('a report is not lost when the lead was not listening at that moment', async () => {
  // the lead's first fleet_wait connection drops before Ada reports; the report must come with the next wait
  const { projectId } = await team({
    lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }], abortFirstWaitMs: 400, pauseAfterAbortMs: 4000, waitMs: 30_000 },
    workers: { Ada: { delayMs: 800 } }
  })
  const ready = await waitReady(projectId, 40_000)
  assert.deepEqual(ready.files, ['a.txt'])
  assert.equal(app!.fakeLog((e) => e.event === 'tool-aborted').length, 1)
  assert.equal(app!.fakeLog((e) => e.event === 'gave-up').length, 0)
})

test("the lead's question shows in the Inbox and the user's click reaches the lead", async () => {
  const { projectId } = await team({
    lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }], ask: { question: 'Which database?', options: ['Postgres', 'SQLite'] } }
  })
  await app!.waitFor(async () => (await app!.texts('.inbox-card')).find((t) => t.includes('Which database?')), { label: 'question card' })
  await app!.click('.inbox-card button', 'SQLite')
  await waitReady(projectId)
  assert.match(app!.fakeLog((e) => e.event === 'answer')[0]?.text ?? '', /The user chose: SQLite/)
  assert.equal((await fleet(projectId)).asks.filter((a: any) => !a.answer).length, 0)
})

test("a worker's permission prompt reaches the Inbox and is answered there", async () => {
  const { projectId } = await team({
    lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] },
    workers: { Ada: { bash: 'npm run build' } }
  })
  const card = await app!.waitFor(async () => (await app!.texts('.inbox-card.approval')).find((t) => t.includes('npm run build')), { label: 'approval card', timeout: 30_000 })
  assert.match(card, /Ada/)
  await app!.click('.inbox-card.approval button', 'Allow once')
  const ready = await waitReady(projectId)
  assert.deepEqual(ready.files, ['a.txt'])
  assert.equal(app!.fakeLog((e) => e.event === 'dialog-answer' && e.name === 'Ada')[0]?.choice, 0)
  assert.equal(toolCalls('fleet_report').length, 1)
})

for (const resume of [true, false]) {
test(`a team survives an app restart (${resume ? 'conversations resumed' : 'started fresh'}): members are re-briefed and the work finishes`, async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  // Ada is still busy when the app quits
  app = await App.launch({ sandbox: sb, scenario: { lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] }, workers: { Ada: { delayMs: 120_000 } } } })
  let projectId = await app.openProject(repo)
  await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt' })
  await app.waitFor(() => app!.fakeLog((e) => e.name === 'Ada' && e.event === 'prompt').length > 0 && toolCalls('fleet_wait').length > 0, { label: 'Ada working, lead waiting', timeout: 30_000 })
  assert.equal(await app.quitLikeUser(), true, 'the app quits')

  // reopen: this time Ada finishes quickly
  app = await App.launch({ sandbox: sb, scenario: { workers: { Ada: { delayMs: 200 } } } })
  projectId = await app.openProject(repo)
  const banner = await app.waitFor(async () => (await app!.texts('.resume-banner')).join(''), { label: 'resume banner' })
  assert.match(banner, /Resume all 2 conversations\?/)
  await app.click('.resume-banner button', resume ? 'Yes' : 'No')

  const ready = await waitReady(projectId, 45_000)
  assert.deepEqual(ready.files, ['a.txt'])
  const briefings = app.fakeLog((e) => e.event === 'prompt' && /\[Fleet\] Fleetboard was restarted/.test(e.prompt))
  assert.deepEqual(briefings.map((e) => e.name).sort(), ['Ada', 'Lead'], 'both were briefed once')
  assert.equal(app.fakeLog((e) => e.event === 'start' && e.name === 'Ada').at(-1).resumed, resume, 'the CLI resume flag follows the choice')
  if (!resume) assert.match(briefings.find((e) => e.name === 'Lead').prompt, /Your goal: add a\.txt/, 'a fresh lead is told its goal')
  assert.equal(app.fakeLog((e) => e.event === 'gave-up').length, 0)
})
}

test('starting a team in a fresh app run sends no restart briefing', async () => {
  const { projectId } = await team({ lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] } })
  await waitReady(projectId)
  assert.equal(app!.fakeLog((e) => e.event === 'prompt' && /restarted/.test(e.prompt)).length, 0)
})

test('a lead that stops mid-task shows in the Inbox; resumed on its tile, it is briefed and finishes', async () => {
  const { projectId } = await team({
    lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }], crashAfterSpawn: true },
    workers: { Ada: { delayMs: 1500 } }
  })
  const card = await app!.waitFor(async () => (await app!.texts('.inbox-card.stopped')).join(''), { label: 'stopped lead card', timeout: 20_000 })
  assert.match(card, /Lead\s*stopped before finishing/)
  // Ada reports to the stopped lead meanwhile; the report waits for it
  await app!.waitFor(() => toolCalls('fleet_report').length > 0, { label: 'Ada reported' })
  await app!.click('.console-exited button', 'Resume')
  const ready = await waitReady(projectId, 30_000)
  assert.deepEqual(ready.files, ['a.txt'], "Ada's work was merged after the lead came back")
  const briefing = app!.fakeLog((e) => e.event === 'prompt' && e.name === 'Lead' && /was restarted/.test(e.prompt))
  assert.equal(briefing.length, 1)
  assert.match(briefing[0].prompt, /Your console was restarted after it stopped/)
  assert.equal((await app!.texts('.inbox-card.stopped')).length, 0, 'the card is gone')
})

test('the fleet and hook servers refuse requests without the secret, from a browser, or to another host', async () => {
  const { sb, projectId } = await team({ lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] } })
  await waitReady(projectId)
  const hooksDir = path.join(sb.fbHome, 'hooks')
  const mcpFile = fs.readdirSync(hooksDir).find((f) => f.startsWith('mcp-'))!
  const server = JSON.parse(fs.readFileSync(path.join(hooksDir, mcpFile), 'utf8')).mcpServers.fleet
  const url = new URL(server.url)
  assert.equal(fs.statSync(path.join(hooksDir, mcpFile)).mode & 0o077, 0, 'the MCP config is readable by the user only')
  const secret = /^Bearer (\S+)$/.exec(server.headers.Authorization)![1]
  assert.ok(!server.url.includes(secret), 'the secret is not part of the URL')
  const member = url.pathname.split('/')[2]
  const auth = { Authorization: `Bearer ${secret}` }
  const call = (pathname: string, headers: Record<string, string> = auth) =>
    fetch(`http://127.0.0.1:${url.port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_status', arguments: {} } })
    })
  assert.equal((await call(url.pathname)).status, 200, 'the real URL and token work')
  assert.equal((await call(url.pathname, {})).status, 403, 'no token')
  assert.equal((await call(url.pathname, { Authorization: `Bearer ${'0'.repeat(secret.length)}` })).status, 403, 'wrong token')
  assert.equal((await call(`/mcp/${secret}/${member}`, {})).status, 404, 'the old secret-in-URL shape is gone')
  assert.equal((await call(url.pathname, { ...auth, Origin: 'https://evil.example' })).status, 403, 'from a web page')
  assert.equal((await call(url.pathname, { ...auth, 'Content-Type': 'text/plain' })).status, 403, 'a no-preflight content type')
  // the hook settings file holds no secret: it comes from each console's environment
  const hooks = fs.readFileSync(path.join(hooksDir, 'claude-hooks.json'), 'utf8')
  assert.ok(!hooks.includes(secret) && hooks.includes('${FB_HOOK_TOKEN}'))
  assert.ok(app!.fakeLog((e) => e.event === 'hook' && e.hook === 'Stop').length > 0, 'hooks still arrive')
})
