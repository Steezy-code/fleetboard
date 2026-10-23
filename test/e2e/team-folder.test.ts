// A team keeps its work apart from the user's files in git worktrees. In a folder where it cannot (not
// a repository, or one without a commit), the user is told and asked before the team starts.
// And the card the gate puts up: the only thing on screen that can start the work.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox, type Sandbox } from './harness'

/** What the drafting call answers for the goal below, so the card has a full one to draw. */
const DRAFTED = {
  understood: 'Add a Split PDF command with tests',
  assumptions: [
    { text: 'the commands are listed in the readme', known: true, from: 'README.md' },
    { text: 'the tests go next to the command', known: false }
  ],
  wontTouch: ['src/renderer'],
  doneWhen: 'npm test',
  ambiguity: 'subject',
  question: { text: 'Which split do you mean?', options: ['by page range', 'by bookmark'] }
}

let app: App
let sb: Sandbox
before(async () => {
  sb = makeSandbox()
  app = await App.launch({ sandbox: sb, scenario: { lead: { tasks: [] }, print: [{ match: 'Split PDF', reply: JSON.stringify(DRAFTED) }] } })
})
after(async () => {
  await app?.close()
})

const leads = async (projectId: string) => Object.values((await app.invoke('fleet:state', projectId))?.members ?? {}).filter((m: any) => m.role === 'lead').length
const dialogText = () => app.waitFor(async () => (await app.texts('body')).join('').match(/Let the team work in your files directly\?[^]*?Start anyway/)?.[0], { label: 'the question' })
const goal = (text = 'tidy up the readme') => app.eval((t) => void (window as any).__fleetboard.sendGoal(t), text)
const charterCard = (label: string) => app.waitFor(async () => (await app.texts('.it-card[data-kind="charter"]'))[0], { label })
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
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closeProject())
})

test('the card is the only thing that starts the work, and the Lead is briefed from what it says', async () => {
  const repo = makeRepo(sb, 'card repo')
  const projectId = await app.openProject(repo)
  // main takes the folder its handlers may read from the board it last loaded or saved, and a folder
  // opened for the first time has neither, so until this board is saved nothing in it can be cited
  // (roots.ts, projectRoot). Without that, every assumption on the card below would be a guess.
  await app.eval(() => (window as any).__fleetboard.useApp.getState().setProjectExtra('e2eSaved', 1))
  await app.waitFor(() => app.invoke<boolean>('fs:exists', path.join(repo, 'README.md')), { label: 'the repo readable' })
  await goal('add a Split PDF command with tests')

  const card = await charterCard('the charter card')
  assert.match(card, /New team\s+starts with this/, 'nobody is working on this yet')
  assert.match(card, /add a Split PDF command with tests/, 'what was typed')
  assert.match(card, /Add a Split PDF command with tests/, 'and what it was taken to mean')
  assert.match(card, /KNOWN\s+the commands are listed in the readme\s+README\.md/i, 'an assumption that cites a real file, with the file')
  assert.match(card, /GUESS\s+the tests go next to the command/i)
  assert.match(card, /Won’t touch\s+src\/renderer/)
  assert.match(card, /Done when\s+npm test/, 'the check that will run is on the card before it is agreed to')
  assert.match(card, /Unclear which thing\s+Which split do you mean\?/, 'the one question, with the kind of gap it is')
  assert.equal(await leads(projectId), 0, 'and nothing has started')

  // dismissed from the card itself, nothing starts
  await app.click('.it-actions button', 'Dismiss')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await leads(projectId), 0, 'dismissing starts nothing')
  assert.deepEqual(await app.texts('.it-card[data-kind="charter"]'), [], 'and the card is gone')

  // again: the question's answers are the card's own buttons, and answering it starts nothing either
  await goal('add a Split PDF command with tests')
  await charterCard('the charter card again')
  await app.click('.it-actions button', 'by page range')
  const answered = await app.waitFor(async () => (await app.texts('.it-card[data-kind="charter"]')).find((t) => t.includes('by page range')), { label: 'the answer on the card' })
  assert.doesNotMatch(answered, /Which split do you mean/, 'the question is settled, not asked again')
  assert.equal(await leads(projectId), 0, 'answering it is not starting it')

  await app.click('.it-actions button', 'Confirm')
  await app.waitFor(async () => (await leads(projectId)) === 1, { label: 'Lead started' })
  const state = await app.invoke('fleet:state', projectId)
  const briefed = (state.messages as any[]).find((m) => m.kind === 'goal')?.text ?? ''
  assert.match(briefed, /Add a Split PDF command with tests — by page range\./, 'the Lead is told what the card said, answer and all')
  assert.match(briefed, /Do not touch: src\/renderer\./)
  assert.match(briefed, /Done when: npm test\./)
  assert.equal(state.charter?.understood, 'Add a Split PDF command with tests — by page range.', 'and the team keeps that charter')

  // a goal typed while that Lead runs is a follow-up to it, and says whose
  const leadName = Object.values(state.members as Record<string, any>).find((m) => m.role === 'lead')?.name
  await goal('also handle encrypted files')
  assert.match(await charterCard('the follow-up card'), new RegExp(`${leadName}\\s+gets this next`))
  await app.click('.it-actions button', 'Dismiss')
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closeProject())
})
