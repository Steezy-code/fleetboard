// Closing the window saves the board even when no console is running. The save is debounced and every
// keystroke pushes it back, so without a flush on close everything typed since the last pause was
// lost — and a note's text lives nowhere but the board file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

const TYPED = 'typed and closed straight away'

test('closing with nothing running flushes the board to disk', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  const app = await App.launch({ sandbox: sb })
  const file = path.join(sb.fbHome, 'projects', `${await app.openProject(repo)}.json`)
  await app.waitFor(() => fs.existsSync(file), { label: 'first save' })
  const nodeId = await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'note', x: 0, y: 0 }) as string)
  await app.waitFor(() => fs.readFileSync(file, 'utf8').includes(nodeId), { label: 'the note itself saved' })

  // The typing and the close go in one round trip, so the debounce is certainly still waiting when
  // the window closes — which is what a real burst of typing followed by clicking X looks like.
  await app
    .eval((id) => {
      const w = window as any
      w.__fleetboard.useApp.getState().updateNodeData(id, { text: 'typed and closed straight away' })
      w.fb.invoke('win:close')
    }, nodeId)
    .catch(() => {
      /* the page may go before the reply does */
    })

  assert.equal(await app.waitExit(10_000), true, 'the app quits by itself')
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(TYPED), 'what was typed is on disk')
})
