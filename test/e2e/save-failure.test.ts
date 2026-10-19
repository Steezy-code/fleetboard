// When the board cannot be saved, the user is told while working, and quitting asks instead of either
// losing the board without a word or refusing to quit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

test('a board that cannot be saved: a warning, then "Quit anyway?" on quit', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  try {
    const projectId = await app.openProject(repo)
    const file = path.join(sb.fbHome, 'projects', `${projectId}.json`)
    await app.waitFor(() => fs.existsSync(file), { label: 'first save' })
    // something in the way of the file: every save now fails
    fs.rmSync(file)
    fs.mkdirSync(file)
    await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'note', x: 0, y: 0 }))
    const toast = await app.waitFor(async () => (await app.texts('.toast')).find((t) => /Could not save the board/.test(t)), { label: 'warning' })
    assert.match(toast, /Could not save the board: \S/)

    // a running console, so quitting asks first
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    await app.waitStatus(id, 'idle')
    await app.invoke('win:close').catch(() => {})
    await app.waitFor(() => app.eval(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Quit')), { label: 'quit confirmation' })
    await app.click('button', 'Quit')
    await app.waitFor(async () => (await app.texts('body')).join('').includes('The board could not be saved'), { label: 'save failure on quit' })
    await app.click('button', 'Quit anyway')
    assert.equal(await app.waitExit(10_000), true, 'the app quit')
  } finally {
    await app.close()
  }
})
