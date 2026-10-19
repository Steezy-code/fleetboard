// A stray error in the main process (an exception in a timer, a rejected promise no one awaited) is
// logged and reported, and the app with its consoles keeps running. Electron's default instead shows a
// modal error box that holds up the process, every console's output with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

test('stray errors in the main process are logged and reported; consoles keep working', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb, mainInspector: true, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    await app.waitStatus(id, 'idle')

    await app.evalMain(`setTimeout(() => { throw new Error('boom in a timer') }, 0); Promise.reject(new Error('a promise no one awaited')); 1`)
    const toast = await app.waitFor(async () => (await app.texts('.toast')).find((t) => /went wrong in the background/.test(t)), { label: 'toast' })
    assert.match(toast, /a promise no one awaited|boom in a timer/)
    const log = path.join(sb.fbHome, 'logs', 'main.log')
    await app.waitFor(() => fs.existsSync(log) && /boom in a timer/.test(fs.readFileSync(log, 'utf8')) && /a promise no one awaited/.test(fs.readFileSync(log, 'utf8')), { label: 'both in the log' })

    // still alive and answering
    assert.equal(await app.invoke('pty:deliver', id, 'still there?'), true)
    await app.waitFor(() => app.fakeLog((e) => e.event === 'prompt' && e.prompt === 'still there?').length > 0, { label: 'console still works' })
    assert.equal(await app.evalMain('1 + 1'), 2)
  } finally {
    await app.close()
  }
})
