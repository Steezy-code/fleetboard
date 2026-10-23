// Editing a file in a studio while an agent changes it on disk: saving never silently overwrites the
// agent's change; the user chooses.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App
let repo: string

before(async () => {
  const sb = makeSandbox()
  repo = makeRepo(sb, 'repo', { 'src/a.ts': 'export const a = 1\n', 'notes.md': '# Notes\n\nfirst\n' })
  app = await App.launch({ sandbox: sb })
  await app.openProject(repo)
})
after(async () => {
  await app?.close()
})

/** Type into the studio's editor (a textarea) the way React sees typing. */
const typeInto = (value: string) =>
  app.eval((value) => {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
const dialog = (re: RegExp) => app.waitFor(async () => (await app.texts('body')).join('').match(re)?.[0], { label: `dialog ${re}` })

test("Code studio: Save after an agent changed the file asks; the agent's change survives until the user replaces it", async () => {
  const file = path.join(repo, 'src/a.ts')
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('code', { path: p }), file)
  await app.waitFor(() => app.eval(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.includes('export const a = 1')), { label: 'file open' })
  await typeInto('export const a = 2 // mine\n')
  fs.writeFileSync(file, 'export const a = 3 // agent\n') // meanwhile
  await app.eval(() => (document.querySelector('button[title="Save (Ctrl+S)"]') as HTMLButtonElement).click())
  await dialog(/a\.ts changed on disk/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 3 // agent\n', 'nothing overwritten while asking')
  await app.click('button', 'Replace with mine')
  await app.waitFor(() => fs.readFileSync(file, 'utf8') === 'export const a = 2 // mine\n', { label: 'replaced when the user said so' })
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
})

test('Markdown studio: autosave after an agent changed the note asks; "load the version on disk" takes it', async () => {
  const file = path.join(repo, 'notes.md')
  await app.eval(() => localStorage.setItem('fb.md.mode', 'source'))
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('markdown', { path: p }), file)
  await app.waitFor(() => app.eval(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.includes('first')), { label: 'note open' })
  fs.writeFileSync(file, '# Notes\n\nfirst\n\nadded by an agent\n')
  await typeInto('# Notes\n\nfirst, edited by me\n') // autosaves shortly after
  await dialog(/notes\.md changed on disk/)
  assert.match(fs.readFileSync(file, 'utf8'), /added by an agent/)
  await app.click('button', 'Cancel')
  await dialog(/Load the version on disk\?/)
  await app.click('button', 'Load the version on disk')
  await app.waitFor(() => app.eval(() => (document.querySelector('textarea') as HTMLTextAreaElement).value.includes('added by an agent')), { label: 'editor shows the disk version' })
  assert.equal(fs.readFileSync(file, 'utf8'), '# Notes\n\nfirst\n\nadded by an agent\n')
  assert.deepEqual(app.rendererErrors, [])
})

test('Markdown studio: keeping your version unsaved is not asked again every autosave, nor after the studio closes', async () => {
  // Declining both dialogs left the edit pending, and the next autosave refused and asked again 600 ms
  // later, for ever — even after the studio closed, over the board, until a destructive choice.
  const file = path.join(repo, 'notes.md')
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  await app.waitFor(() => app.eval(() => !document.querySelector('textarea')), { label: 'the studio closed' })
  fs.writeFileSync(file, '# Notes\n\nsecond\n')
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('markdown', { path: p }), file)
  await app.waitFor(() => app.eval(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.includes('second')), { label: 'note open' })
  fs.writeFileSync(file, '# Notes\n\nsecond, by an agent\n')
  await typeInto('# Notes\n\nsecond, mine\n')
  await dialog(/notes\.md changed on disk/)
  await app.click('button', 'Cancel')
  await dialog(/Load the version on disk\?/)
  await app.click('button', 'Cancel')
  const asking = async () => (await app.texts('.modal.confirm')).length > 0
  await new Promise((r) => setTimeout(r, 2000))
  assert.equal(await asking(), false, 'not asked again')
  assert.match((await app.texts('.wb-save-state')).join(''), /Changed on disk/)
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  await new Promise((r) => setTimeout(r, 2000))
  assert.equal(await asking(), false, 'nor over the board once the studio closed')
  assert.equal(fs.readFileSync(file, 'utf8'), '# Notes\n\nsecond, by an agent\n', "the agent's text is untouched")
  assert.deepEqual(app.rendererErrors, [])
})

test('Markdown studio: a note it could not read is never saved over', async () => {
  // The bulk prefetch used to fill the notes map but not the "what is on disk" map, and a read that
  // failed cached the empty string. fs:write with no base overwrites unconditionally, so a note that
  // failed to read showed as empty, claimed to be saved, and the first keystroke replaced the real
  // file with that empty buffer. Here the note is simply not there (removed between the tree read and
  // the open, a stale wiki link): the same missing base, and nothing may be written.
  const file = path.join(repo, 'ghost.md')
  assert.equal(fs.existsSync(file), false, 'not there to begin with')
  await app.eval(() => localStorage.setItem('fb.md.mode', 'source'))
  // the studio from the test before is still mounted: a new path prop alone would not reload it
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  await app.waitFor(() => app.eval(() => !document.querySelector('textarea')), { label: 'the studio closed' })
  await app.eval((p) => (window as any).__fleetboard.useApp.getState().openPanel('markdown', { path: p }), file)
  await app.waitFor(async () => (await app.texts('body')).join('').includes('Could not open ghost.md'), { label: 'the failed read is reported' })
  await typeInto('# typed into a note that was never read\n')
  await new Promise((r) => setTimeout(r, 1500)) // well past the 600 ms autosave
  assert.equal(fs.existsSync(file), false, 'nothing was written')
  assert.ok((await app.texts('body')).join('').includes('could not be read, so it is not saved over'), 'and the user is told why')
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  assert.deepEqual(app.rendererErrors, [])
})
