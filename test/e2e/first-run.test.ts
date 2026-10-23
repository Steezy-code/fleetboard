// The first five minutes, in the built app: the home screen says which agents can take work, an empty
// board offers goals taken from the repo, picking one puts it in the bar (and sends nothing), and the
// Inbox explains itself once, the first time an agent asks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App, makeRepo, makeSandbox } from './harness'

test('home readiness, goals from the repo, and a tip shown once', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'repo', {
    'PLAN.md': '# Plan\n\n- [x] Parse the config\n- [ ] Add a --dry-run flag that prints what would change\n',
    'src/sync.ts': '// TODO: retry the upload when the connection drops halfway\nexport const x = 1\n'
  })
  const app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: 'deploy', bash: 'npm run build', reply: 'ok' }] } })
  try {
    // the sandbox's claude is installed but never signed in: the home screen must not call it ready
    const claude = await app.waitFor(async () => (await app.texts('.ar-row')).find((t) => t.startsWith('Claude Code') && !/Looking/.test(t)), { label: 'Claude Code row' })
    assert.match(claude, /no sign-in found/)
    assert.match(claude, /Sign in once, in a terminal:\s*claude/)

    await app.openProject(repo)
    const ideas = await app.waitFor(async () => {
      const t = await app.texts('.eb-idea-text')
      return t.length ? t : null
    }, { label: 'goal ideas' })
    assert.deepEqual(ideas, [
      'Add a --dry-run flag that prints what would change',
      'Resolve the TODO in src/sync.ts (line 1): retry the upload when the connection drops halfway',
      'Write a README that says what this is and how to run it'
    ])
    await app.click('.eb-idea', '--dry-run')
    await app.waitFor(async () => (await app.eval(() => (document.querySelector('.command-bar input') as HTMLInputElement)?.value)) === 'Add a --dry-run flag that prints what would change', { label: 'the goal is in the bar' })
    // picking a goal only fills the bar: no Lead, and no charter waiting for a yes
    const projectId = await app.eval(() => (window as any).__fleetboard.useApp.getState().project.id as string)
    assert.deepEqual(Object.keys((await app.invoke('fleet:state', projectId))?.members ?? {}), [])
    assert.equal(await app.eval(() => (window as any).__fleetboard.useCharter.getState().pending ?? null), null)

    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    await app.waitStatus(id, 'idle')
    await app.eval(({ id }) => (window as any).__fleetboard.sendToConsole(id, 'deploy', true), { id })
    await app.waitStatus(id, 'needs-you')
    const tip = await app.waitFor(async () => (await app.texts('.inbox-tray .tip')).find((t) => /Agents stop and ask here/.test(t)), { label: 'the Inbox tip' })
    assert.ok(tip)
    await app.click('.inbox-tray .tip button', 'Got it')
    assert.deepEqual(await app.invoke('store:getGlobal', 'tipsSeen'), { inbox: true }, 'remembered, so it is shown once')
    await app.waitFor(async () => (await app.texts('.inbox-tray .tip')).length === 0, { label: 'the tip is gone' })
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})
