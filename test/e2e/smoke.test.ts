// Every panel, drawer, studio and kind of tile opens without an error in the app window.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

let app: App

before(async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'repo', {
    'README.md': '# demo\n\nSee [notes](notes.md).\n',
    'notes.md': '# Notes\n\n- one\n- two\n\n```mermaid\ngraph TD; A-->B\n```\n',
    'src/app.ts': 'export const answer = 42\n',
    'docs/guide.html': '<h1>Guide</h1><p>Hello</p>'
  })
  app = await App.launch({ sandbox: sb, scenario: { solo: [{ match: '.', reply: 'ok' }] } })
  await app.openProject(repo)
})

after(async () => {
  if (process.env.E2E_SHOTS) await app?.screenshot(path.join(process.env.E2E_SHOTS, 'smoke.png')).catch(() => {})
  await app?.close()
})

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms))
async function noNewErrors(what: string, from: number) {
  await settle()
  const errors = app.rendererErrors.slice(from)
  assert.deepEqual(errors, [], `${what}: errors in the app window`)
  assert.ok(await app.eval(() => !!document.querySelector('#root')?.children.length), `${what}: the app is still on screen`)
}

test('every kind of tile renders', async () => {
  const types = await app.eval(() => Object.keys((window as any).__fleetboard.NODE_DEFS ?? {}))
  assert.ok(types.length >= 10, `node types: ${types}`)
  for (const type of types) {
    if (type === 'console') continue // consoles are covered by their own tests
    const n = app.rendererErrors.length
    await app.eval((type) => (window as any).__fleetboard.useApp.getState().addNode({ type, x: 100, y: 100 }), type)
    await noNewErrors(`a ${type} tile`, n)
  }
})

test('every panel and studio opens and closes', async () => {
  const panels = await app.eval(() => Object.keys((window as any).__fleetboard.PANELS ?? {}))
  assert.ok(panels.length >= 10, `panels: ${panels}`)
  for (const name of panels) {
    const n = app.rendererErrors.length
    await app.eval((name) => (window as any).__fleetboard.useApp.getState().openPanel(name), name)
    await noNewErrors(`the ${name} panel`, n)
    await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
  }
})

test('every drawer opens and closes', async () => {
  const drawers = await app.eval(() => Object.keys((window as any).__fleetboard.DRAWERS ?? {}))
  assert.ok(drawers.length >= 4, `drawers: ${drawers}`)
  for (const name of drawers) {
    const n = app.rendererErrors.length
    await app.eval((name) => (window as any).__fleetboard.useApp.getState().openDrawer(name), name)
    await noNewErrors(`the ${name} drawer`, n)
    await app.eval(() => (window as any).__fleetboard.useApp.getState().closeDrawer())
  }
})

test('a tile that cannot render its data stays inside its frame: the rest of the app works, and it can be removed', async () => {
  const good = await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'checklist', x: 0, y: 0, data: { items: [{ id: 'i1', text: 'still here', done: false }] } }))
  // a value of the wrong kind, as an older version or a hand edit can leave in a saved board
  const bad = await app.eval(() => (window as any).__fleetboard.useApp.getState().addNode({ type: 'web', x: 400, y: 0, data: { url: 42 } }))
  const message = await app.waitFor(async () => (await app.texts(`[data-node-id="${bad}"] .boundary`)).join(''), { label: 'error in the tile' })
  assert.match(message, /This web tile could not be shown/)
  const other = await app.eval((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`)
    return { there: !!el, failed: !!el?.querySelector('.boundary'), text: [...(el?.querySelectorAll('input, textarea') ?? [])].map((i: any) => i.value).join(' ') + (el?.textContent ?? '') }
  }, good)
  assert.deepEqual([other.there, other.failed], [true, false], 'other tiles are untouched')
  assert.match(other.text, /still here/)
  assert.equal(await app.eval(() => document.querySelectorAll('.boundary').length), 1, 'only that tile failed')
  await app.click(`[data-node-id="${bad}"] .boundary button`, 'Remove tile')
  await app.waitFor(async () => !(await app.eval((id) => !!document.querySelector(`[data-node-id="${id}"]`), bad)), { label: 'tile removed' })
})

test('the app knows which Fleetboard it is, and asks GitHub once whether there is a newer one', async () => {
  const out = await app.invoke<{ current: string; latest: unknown; newer: unknown; error?: string }>('update:check')
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'))
  assert.equal(out.current, pkg.version, "Fleetboard's own version, not Electron's")
  assert.equal(out.newer, null, 'no release is newer than the build under test')
  // whatever gh does in the sandbox — missing, signed out, no releases — the answer is usable, not a throw
  assert.ok(out.error === undefined || typeof out.error === 'string')
  await app.eval(() => (window as any).__fleetboard.useApp.getState().openPanel('settings'))
  // the check can take a few seconds (gh, over the network), and the row says so while it does
  const shown = await app.waitFor(
    async () => {
      const t = (await app.texts('[data-section="data"] .settings-row')).join(' | ')
      return t.includes('Checking for a newer release') ? '' : t
    },
    { label: 'the version row, settled' }
  )
  assert.ok(shown.includes(`Fleetboard ${out.current}`), shown)
  await app.eval(() => (window as any).__fleetboard.useApp.getState().closePanel())
})
