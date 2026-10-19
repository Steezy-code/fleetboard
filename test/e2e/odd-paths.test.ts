// A project whose folder and files have spaces, quotes, accents and shell characters: consoles, a team,
// the git drawer's status, diff and commit, and the studios all work there.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox, type Sandbox } from './harness'

const NAME = `Lu's café – "draft" $HOME (1)`
const FILE = `notes & ideas/it's $x; [1].md`
let app: App
let sb: Sandbox
let repo: string
let projectId: string
before(async () => {
  sb = makeSandbox()
  repo = makeRepo(sb, NAME, { 'README.md': '# demo\n', [FILE]: '# odd\n' })
  app = await App.launch({
    sandbox: sb,
    scenario: {
      solo: [{ match: '.', reply: 'ok' }],
      lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }] }
    }
  })
  projectId = await app.openProject(repo)
})
after(async () => {
  await app?.close()
})

test('a console starts in the folder', async () => {
  const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
  await app.waitStatus(id, 'idle')
  const info = (await app.invoke('pty:list')).find((p: any) => p.id === id)
  if (fs.existsSync(`/proc/${info.pid}/cwd`)) assert.equal(fs.readlinkSync(`/proc/${info.pid}/cwd`), repo)
  await app.invoke('pty:deliver', id, 'hello')
  await app.waitFor(async () => /ok/.test(await app.invoke('pty:tail', id, 2000)), { label: 'reply' })
})

test('a team plans, works in a worktree and merges into the checkout', async () => {
  await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add the file' })
  await app.waitFor(async () => (await app.invoke('fleet:state', projectId))?.ready, { timeout: 60_000, label: 'Ready card' })
  const res = await app.invoke('fleet:mergeReady', projectId)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')))
})

test("the git drawer: status, a new file's diff, and a commit of just that file", async () => {
  fs.writeFileSync(path.join(repo, FILE), '# odd\n\nchanged\n')
  const extra = `more/$(touch pwned) \`x\`.txt`
  fs.mkdirSync(path.join(repo, 'more'), { recursive: true })
  fs.writeFileSync(path.join(repo, extra), 'new\n')
  const st = await app.invoke('git:status', repo)
  assert.equal(st.ok, true, JSON.stringify(st))
  const paths = st.status.files.map((f: any) => f.path).sort()
  assert.ok(paths.includes(FILE), JSON.stringify(paths))
  const d = await app.invoke('git:diff', repo, FILE, {})
  assert.match(d.diff, /\+changed/)
  const c = await app.invoke('git:commit', repo, 'Change the odd note', [{ path: FILE }])
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(git(sb, repo, 'log', '-1', '--format=%s'), 'Change the odd note')
  assert.equal(git(sb, repo, 'show', '--name-only', '--format=', 'HEAD'), FILE)
  assert.equal(fs.existsSync(path.join(repo, 'more', 'pwned')), false, 'nothing in a file name ran')
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false)
})

test('the studios open the odd file', async () => {
  await app.eval(() => localStorage.setItem('fb.md.mode', 'source'))
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('markdown', { path: p }), path.join(repo, FILE))
  await app.waitFor(() => app.eval(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('changed'))), { label: 'note open' })
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('code', { path: p }), path.join(repo, FILE))
  await app.waitFor(() => app.eval(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('changed'))), { label: 'file open' })
  assert.deepEqual(app.rendererErrors, [])
})
