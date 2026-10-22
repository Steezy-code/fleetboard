// A team keeps its work apart from the user's files in git worktrees. In a folder where it cannot (not
// a repository, or one without a commit), the user is told and asked before the team starts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox, type Sandbox } from './harness'

let app: App
let sb: Sandbox
before(async () => {
  sb = makeSandbox()
  app = await App.launch({ sandbox: sb, scenario: { lead: { tasks: [] } } })
})
after(async () => {
  await app?.close()
})

const leads = async (projectId: string) => Object.values((await app.invoke('fleet:state', projectId))?.members ?? {}).filter((m: any) => m.role === 'lead').length
const dialogText = () => app.waitFor(async () => (await app.texts('body')).join('').match(/Let the team work in your files directly\?[^]*?Start anyway/)?.[0], { label: 'the question' })
const goal = () => app.eval(() => void (window as any).__fleetboard.sendGoal('tidy up the readme'))
// every goal waits at the gate for a glance before anything starts, the folder question included
const charterUp = () => app.waitFor(() => app.eval(() => !!(window as any).__fleetboard.useCharter.getState().pending), { label: 'the charter' })
const confirmCharter = async () => {
  await charterUp()
  await app.eval(() => (window as any).__fleetboard.useCharter.getState().confirm())
}

test('a folder that is not a repository: asked first; Cancel starts nothing, Start anyway starts the Lead', async () => {
  const dir = path.join(sb.home, 'plain folder')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# plain\n')
  const projectId = await app.openProject(dir)
  await goal()
  await charterUp()
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await leads(projectId), 0, 'nothing starts while the charter waits')
  assert.doesNotMatch((await app.texts('body')).join(''), /Let the team work in your files directly/, 'and the folder question comes after it')
  await confirmCharter()
  assert.match(await dialogText(), /not a git repository/)
  await app.click('button', 'Cancel')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await leads(projectId), 0, 'nothing started')
  await goal()
  await confirmCharter()
  await dialogText()
  await app.click('button', 'Start anyway')
  await app.waitFor(async () => (await leads(projectId)) === 1, { label: 'Lead started' })
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closeProject())
})

test('a repository without a commit: asked too', async () => {
  const dir = path.join(sb.home, 'fresh repo')
  fs.mkdirSync(dir, { recursive: true })
  git(sb, dir, 'init', '-q')
  const projectId = await app.openProject(dir)
  await goal()
  await confirmCharter()
  assert.match(await dialogText(), /no commits yet/)
  await app.click('button', 'Cancel')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await leads(projectId), 0)
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closeProject())
})

test('a repository with a commit: the team starts in worktrees without a question', async () => {
  const repo = makeRepo(sb, 'real repo')
  const projectId = await app.openProject(repo)
  await goal()
  await confirmCharter()
  await app.waitFor(async () => (await leads(projectId)) === 1, { label: 'Lead started' })
  assert.doesNotMatch((await app.texts('body')).join(''), /Let the team work in your files directly/)
})
