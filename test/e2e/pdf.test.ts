// Markdown to PDF: the main process prints the renderer's HTML in a window that runs no script.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App | null = null
after(async () => {
  await app?.close()
})

test('a document prints to PDF from a window with scripts off', async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  app = await App.launch({ sandbox: sb })
  await app.openProject(repo)
  const out = path.join(repo, 'notes.pdf')
  const html = '<!doctype html><html><body><h1>Notes</h1><p>printed</p></body></html>'
  assert.equal(await app.invoke('pdf:fromHtml', html, out), out)
  const pdf = fs.readFileSync(out)
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.length > 1000, 'a page was printed')
  assert.deepEqual(app.rendererErrors, [])
})
