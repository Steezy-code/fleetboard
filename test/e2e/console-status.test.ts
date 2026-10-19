import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App
let repo: string

before(async () => {
  const sb = makeSandbox()
  repo = makeRepo(sb)
  app = await App.launch({
    sandbox: sb,
    scenario: { solo: [{ match: 'deploy', bash: 'rm -rf build', reply: 'deployed' }, { match: 'slow', workMs: 3000, reply: 'slow done' }] }
  })
  await app.openProject(repo)
})

after(async () => {
  if (process.env.E2E_SHOTS) await app?.screenshot(path.join(process.env.E2E_SHOTS, 'console-status.png'))
  assert.equal(await app?.close(), true, 'the app quits cleanly')
})

const spawnClaude = () => app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
const send = (id: string, text: string) => app.eval(({ id, text }) => (window as any).__fleetboard.sendToConsole(id, text, true), { id, text })

test('a console goes starting → idle (SessionStart hook) → working → idle', async () => {
  const id = await spawnClaude()
  await app.waitStatus(id, 'idle')
  assert.ok(app.fakeLog((e) => e.event === 'hook' && e.hook === 'SessionStart').length > 0, 'the hook ran through the hook server')
  await send(id, 'a slow task')
  await app.waitStatus(id, 'working')
  await app.waitStatus(id, 'idle', 15_000)
  assert.ok(app.fakeLog((e) => e.event === 'prompt' && e.prompt === 'a slow task').length === 1, 'typed once, submitted once')
})

test('a permission dialog: needs-you, an Inbox card with the right buttons, answered from the Inbox', async () => {
  const id = await spawnClaude()
  await app.waitStatus(id, 'idle')
  await send(id, 'please deploy')
  await app.waitStatus(id, 'needs-you')

  const card = await app.waitFor(async () => (await app.texts('.inbox-card.approval')).find((t) => t.includes('Do you want to proceed?')), { label: 'Inbox card' })
  assert.match(card, /rm -rf build/)
  const buttons = await app.texts('.inbox-card.approval .ic-actions button')
  assert.deepEqual(buttons, ['Allow once', 'Always allow this command', 'Deny'])

  await app.click('.inbox-card.approval .ic-actions button', 'Deny')
  await app.waitFor(() => app.fakeLog((e) => e.event === 'dialog-answer').length > 0, { label: 'dialog answered' })
  assert.equal(app.fakeLog((e) => e.event === 'dialog-answer').at(-1).choice, 2, 'the Deny option was chosen with the arrow keys')
  await app.waitStatus(id, 'idle')
  assert.equal((await app.texts('.inbox-card.approval')).length, 0, 'the card is gone')
})

test('a stale answer is refused and types nothing', async () => {
  const id = await spawnClaude()
  await app.waitStatus(id, 'idle')
  const keysBefore = app.fakeLog((e) => e.event === 'keys').length
  const res = await app.invoke('pty:answer', id, { option: 'Yes' })
  assert.deepEqual(res, { ok: false, reason: 'gone' })
  assert.equal(app.fakeLog((e) => e.event === 'keys').length, keysBefore, 'no keystrokes reached the agent')
  assert.deepEqual(await app.invoke('pty:answer', 'no-such-console', { enter: true }), { ok: false, reason: 'not-live' })
})

test('pty:prompt reads the dialog structurally', async () => {
  const id = await spawnClaude()
  await app.waitStatus(id, 'idle')
  await send(id, 'deploy again')
  await app.waitStatus(id, 'needs-you')
  const p = await app.invoke('pty:prompt', id)
  assert.equal(p.kind, 'menu')
  assert.equal(p.question, 'Do you want to proceed?')
  assert.deepEqual(
    p.options.map((o: any) => o.label),
    ['Yes', "Yes, and don't ask again for this command", 'No']
  )
  assert.deepEqual(await app.invoke('pty:answer', id, { option: 'Yes' }), { ok: true })
  await app.waitStatus(id, 'idle')
  assert.equal(app.fakeLog((e) => e.event === 'dialog-answer').at(-1).choice, 0)
})

test('a first prompt waits behind a startup question instead of answering it', async () => {
  const sb2 = makeSandbox()
  const repo2 = makeRepo(sb2)
  const app2 = await App.launch({
    sandbox: sb2,
    scenario: {
      startupMenu: { question: 'Make auto mode your default permission mode?', explain: 'Auto mode lets Claude handle permission prompts automatically.', options: ['Yes, set auto mode as my default permission mode', 'No, keep manual mode'] },
      solo: [{ match: 'hello', reply: 'hi there' }]
    }
  })
  try {
    await app2.openProject(repo2)
    const id = await app2.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude', initialPrompt: 'hello' })[0] as string)
    await app2.waitStatus(id, 'needs-you')
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal(app2.fakeLog((e) => e.event === 'startup-answer').length, 0, 'nothing answered the question for the user')
    assert.equal(app2.fakeLog((e) => e.event === 'prompt').length, 0, 'the prompt is still waiting')
    const card = await app2.waitFor(async () => (await app2.texts('.inbox-card.approval')).find((t) => /auto mode your default/.test(t)), { label: 'Inbox card' })
    assert.match(card, /No, keep manual mode/)
    await app2.click('.inbox-card.approval .ic-actions button', 'No, keep manual mode')
    await app2.waitFor(() => app2.fakeLog((e) => e.event === 'prompt' && e.prompt === 'hello').length, { label: 'prompt delivered after the answer' })
    assert.equal(app2.fakeLog((e) => e.event === 'startup-answer')[0].choice, 'No, keep manual mode')
  } finally {
    await app2.close()
  }
})
