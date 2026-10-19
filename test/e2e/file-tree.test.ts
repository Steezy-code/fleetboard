// The studios' file tree in a project with deep folders (Java: src/main/java/com/acme/...): every
// folder can be opened, however deep, and a file deep down opened from a link shows in the tree.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

const DEEP = 'src/main/java/com/acme/billing/service/impl/invoice/pdf/InvoicePdf.java'
const NOTE = 'docs/a/b/c/d/e/f/g/h/i/deep-note.md'
let app: App
let repo: string
before(async () => {
  const sb = makeSandbox()
  repo = makeRepo(sb, 'repo', { 'README.md': '# demo\n', [DEEP]: 'class InvoicePdf {}\n', [NOTE]: '# Deep note\n' })
  app = await App.launch({ sandbox: sb })
  await app.openProject(repo)
})
after(async () => {
  await app?.close()
})

const rows = () => app.texts('.ftree .ft-row .ft-name')
const clickRow = (name: string) =>
  app.eval((name) => {
    const row = [...document.querySelectorAll('.ftree .ft-row')].find((r) => r.querySelector('.ft-name')?.textContent === name) as HTMLElement | undefined
    row?.click()
    return !!row
  }, name)

test('Code studio: folders opened one by one, down to a file 10 levels deep', async () => {
  await app.eval(() => (window as any).__fleetboard.useApp.getState().openPanel('code'))
  await app.waitFor(async () => (await rows()).includes('src'), { label: 'tree' })
  const parts = DEEP.split('/')
  for (const dir of parts.slice(0, -1)) {
    await app.waitFor(() => clickRow(dir), { label: `folder ${dir}` })
  }
  await app.waitFor(async () => (await rows()).includes('InvoicePdf.java'), { label: 'the file, deep down' })
  await clickRow('InvoicePdf.java')
  await app.waitFor(() => app.eval(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.includes('class InvoicePdf')), { label: 'file open' })
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
})

test('Code studio: a deep file opened directly is revealed in the tree', async () => {
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('code', { path: p }), path.join(repo, DEEP))
  await app.waitFor(async () => (await app.texts('.ftree .ft-row.active .ft-name')).includes('InvoicePdf.java'), { label: 'active file in the tree' })
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
})

test('Markdown studio: a note 10 folders deep is reachable', async () => {
  await app.eval(() => localStorage.setItem('fb.md.mode', 'source'))
  await app.eval(() => (window as any).__fleetboard.useApp.getState().openPanel('markdown'))
  await app.waitFor(async () => (await rows()).includes('docs'), { label: 'notes tree' })
  for (const dir of NOTE.split('/').slice(0, -1)) await app.waitFor(() => clickRow(dir), { label: `folder ${dir}` })
  await app.waitFor(async () => (await rows()).includes('deep-note'), { label: 'the note, deep down' })
  assert.deepEqual(app.rendererErrors, [])
})
