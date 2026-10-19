// A console for an agent CLI that is not installed says so, and how to install it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App, makeRepo, makeSandbox } from './harness'

test('a console for a CLI that is not installed explains what is missing and how to get it', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'aider' })[0] as string)
    // the terminal wraps the message over several rows
    const text = await app.waitFor(async () => (await app.texts(`[data-node-id="${id}"] .xterm-rows`)).join('').replace(/\n/g, '').match(/Could not start Aider: .*/)?.[0], { label: 'message' })
    assert.match(text, /Aider is not installed: "aider" was not found on your PATH\. See https:\/\/aider\.chat/)
    assert.doesNotMatch(text, /execvp|Error invoking remote method/)
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})
