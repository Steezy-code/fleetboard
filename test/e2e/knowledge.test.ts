// Repo knowledge in the real app: read from the repo's own files when the board opens, shown with
// where each fact came from, a correction that outlives the next read, and a charter that cites it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox, type Sandbox } from './harness'

/** What the drafting call answers: an assumption resting on the fact the read found. */
const DRAFTED = {
  understood: 'Add a Split PDF command with tests',
  assumptions: [{ text: 'npm test is how this repo is checked', known: true, from: 'fact:checks.test' }],
  wontTouch: [],
  doneWhen: 'npm test'
}

let app: App
let sb: Sandbox
let repo: string
before(async () => {
  sb = makeSandbox()
  repo = makeRepo(sb, 'known repo', { 'README.md': '# demo\n', 'package.json': JSON.stringify({ scripts: { test: 'node --test', dev: 'vite' } }) })
  app = await App.launch({ sandbox: sb, scenario: { print: [{ match: 'Split PDF', reply: JSON.stringify(DRAFTED) }] } })
  await app.openProject(repo)
  // saved once, so the main process takes this folder as the open board's (roots.ts) whatever order the reads come in
  await app.eval(() => (window as any).__fleetboard.useApp.getState().setProjectExtra('e2eSaved', 1))
  await app.waitFor(() => app.invoke('knowledge:read', repo), { label: 'the repo readable' })
})
after(async () => {
  await app?.close()
})

const factCard = (label: string) => app.waitFor(async () => (await app.texts('.kn-fact[data-key="checks.test"]'))[0], { label })
const reread = () => app.eval(() => (window as any).__fleetboard.knowledge.refreshKnowledge(true).then(() => true))

test('the panel shows what was read from the repo, and a correction outlives the next read', async () => {
  await reread()
  await app.eval(() => (window as any).__fleetboard.useApp.getState().openPanel('knowledge'))
  const card = await factCard('the npm test fact')
  assert.match(card, /read from the repo/i)
  assert.match(card, /package\.json/)
  assert.match(card, /`npm test` runs node --test/)
  assert.equal((await app.texts('.kn-fact[data-key="checks.dev"]')).length, 0, 'a dev server is not a check')

  await app.click('.kn-fact[data-key="checks.test"] button[title="Correct it"]')
  await app.eval((text) => {
    const el = document.querySelector<HTMLInputElement>('.kn-fact[data-key="checks.test"] input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, '`npm test` runs the unit tests only; e2e is separate')
  await app.click('.kn-fact[data-key="checks.test"] button[title^="Save"]')
  await new Promise((r) => setTimeout(r, 200))
  if (process.env.E2E_SHOTS) await app.screenshot(path.join(process.env.E2E_SHOTS, 'knowledge-panel.png'))
  const corrected = await app.waitFor(async () => (await factCard('the corrected fact')).match(/from you[^]*unit tests only/i)?.[0], { label: 'the correction, as yours' })
  assert.ok(corrected)

  await reread()
  await new Promise((r) => setTimeout(r, 300))
  assert.match(await factCard('the fact after a read'), /unit tests only; e2e is separate/, 'the read did not put the old text back')
  const saved = await app.eval(() => (window as any).__fleetboard.knowledge.currentKnowledge().facts.find((f: any) => f.key === 'checks.test'))
  assert.equal(saved.provenance, 'you')
  assert.equal(saved.command, 'npm test', 'and the command it runs is kept')
  await app.click('.modal-head button[title="Close"]')
})

test('a charter drafted in this repo cites the fact, and is shown it was', async () => {
  await app.eval(() => void (window as any).__fleetboard.sendGoal('add a Split PDF command with tests'))
  const card = await app.waitFor(async () => (await app.texts('.it-card[data-kind="charter"]'))[0], { label: 'the charter card' })
  // every line of it rests on something known, so it is confident enough to be a glance: one line, the check still on it
  assert.match(card, /Add a Split PDF command with tests\s+npm test/)
  // the log keeps the start of a prompt, where the facts are; the request itself comes last
  const prompt = app.fakeLog((e) => e.event === 'print').at(-1)?.prompt ?? ''
  assert.match(prompt, /fact:checks\.test \(from you, package\.json\)/, 'the draft was shown the fact, as corrected')
  const pending = await app.eval(() => (window as any).__fleetboard.useCharter.getState().pending)
  assert.deepEqual(pending.assumptions[0], { text: 'npm test is how this repo is checked', known: true, from: 'package.json', fact: 'checks.test' }, 'known, citing the fact and where it came from')
  assert.ok(pending.confidence >= 80, `confidence ${pending.confidence}`)
  await app.click('.it-actions button', 'Dismiss')
})
