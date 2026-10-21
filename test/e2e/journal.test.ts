// The night log: what the app did while nobody was watching, and what it agreed to on their behalf.
// A toast lives 4200 ms, so before this there was nothing to read in the morning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

test('a console starting, and a prompt answered for you, are both in the night log', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  // `bash` makes the fake agent put a real permission dialog on screen, as console-status does
  const app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: 'deploy', bash: 'rm -rf build', reply: 'deployed' }] } })
  try {
    await app.openProject(repo)
    const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
    await app.waitStatus(id, 'idle')
    await app.eval(({ id }) => (window as any).__fleetboard.sendToConsole(id, 'deploy again', true), { id })
    await app.waitStatus(id, 'needs-you')

    // answered on the board, which is the thing the log exists to be able to tell you about
    await app.invoke('pty:answer', id, { option: 'Yes' })

    const dir = path.join(sb.fbHome, 'journal')
    const lines = await app.waitFor(
      () => {
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
        const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
        const all = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        return all.some((e) => e.kind === 'prompt.answer') ? all : null
      },
      { label: 'the answer reached the journal' }
    )
    const started = lines.find((e: any) => e.kind === 'console.start')
    assert.ok(started, 'the console starting is the frame the rest sits in')
    assert.match(started.text, /claude started in /)
    const answer = lines.find((e: any) => e.kind === 'prompt.answer')
    assert.match(answer.text, /you, on the board answered "Yes"/, 'who answered, not just what')
    assert.equal(answer.detail.consoleId, id)

    // and it is readable in the app, which is where it will actually be read
    await app.eval(() => (window as any).__fleetboard.useApp.getState().openDrawer('journal'))
    await app.waitFor(async () => (await app.texts('.journal-row')).some((t) => /answered "Yes"/.test(t)), { label: 'the drawer shows it' })
    await app.click('.drawer .seg button', 'Decisions')
    // Narrowing the list is a re-render, so wait for the console rows to go rather than give React a
    // fixed 50 ms to have done it — which is a race, and the one timing assumption left in this file.
    const decisions = await app.waitFor(
      async () => {
        const rows = await app.texts('.journal-row')
        // an empty array is a result, not "not yet": a filter that drops everything should fail
        // the assertion below by name rather than time out here
        return rows.some((t) => /started in/.test(t)) ? null : rows
      },
      { label: 'Decisions drops the rest' }
    )
    assert.ok(
      decisions.some((t: string) => /answered "Yes"/.test(t)),
      'Decisions keeps what was decided for you'
    )
    assert.deepEqual(app.rendererErrors, [])
  } finally {
    await app.close()
  }
})
