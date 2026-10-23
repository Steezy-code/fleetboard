// Unsaved editor work is asked about before it would be dropped, and only then.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { mayDropUnsaved, setUnsaved } = await import('@/lib/unsaved')
void ipc

test('nothing unsaved: no question; something unsaved: asked, and the answer decides', async () => {
  useApp.setState({ confirms: [] } as never)
  assert.equal(await mayDropUnsaved('Quit'), true)
  assert.equal(useApp.getState().confirms.length, 0)

  setUnsaved('code', 'parser.ts')
  setUnsaved('skill', '/review')
  const asked = mayDropUnsaved('Quit')
  await new Promise((r) => setTimeout(r, 0))
  const c = useApp.getState().confirms[0] as { title: string; resolve: (ok: boolean) => void }
  assert.equal(c.title, 'Quit without saving parser.ts and /review?')
  c.resolve(false)
  assert.equal(await asked, false)

  setUnsaved('code', null)
  setUnsaved('skill', null)
  assert.equal(await mayDropUnsaved('Quit'), true, 'saved again: no question')
})
