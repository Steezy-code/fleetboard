// The phone Inbox: off by default; when on, a page that answers approvals, the Lead's questions and
// the Ready card, opened here in a real Chromium page (a web tile), plus its API's defenses.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, git, makeRepo, makeSandbox, type Sandbox } from './harness'

let app: App
let sb: Sandbox
let repo: string
let projectId: string

before(async () => {
  sb = makeSandbox()
  repo = makeRepo(sb)
  app = await App.launch({
    sandbox: sb,
    scenario: {
      solo: [{ match: 'deploy', bash: 'npm run deploy', reply: 'deployed' }],
      lead: { tasks: [{ task: 'Write a.txt', owns: ['a.txt'], done_when: 'a.txt exists', name: 'Ada' }], ask: { question: 'Ship to staging or prod?', options: ['Staging', 'Prod'] } }
    }
  })
  projectId = await app.openProject(repo)
})

after(async () => {
  await app?.close()
})

const api = (url: string, p: string, init: RequestInit = {}, token?: string) => {
  const u = new URL(url)
  return fetch(`${u.origin}${p}`, { ...init, headers: { ...(token !== '' ? { Authorization: `Bearer ${token ?? u.hash.slice(1)}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
}

test('off by default: nothing listens until it is turned on', async () => {
  const st = await app.invoke('remote:status')
  assert.equal(st.enabled, false)
  assert.equal(st.running, false)
  assert.equal(st.url, undefined)
  assert.equal(fs.statSync(path.join(sb.fbHome, 'remote.json')).mode & 0o077, 0, 'the secret is stored for the user only')
})

test('answering a permission prompt from the phone page', async () => {
  const id = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agentId: 'claude' })[0] as string)
  await app.waitStatus(id, 'idle')
  await app.eval((id) => (window as any).__fleetboard.sendToConsole(id, 'please deploy'), id)
  await app.waitStatus(id, 'needs-you')

  const st = await app.invoke('remote:enable', 'local')
  assert.equal(st.running, true, st.error)
  assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{48}$/)
  assert.match(st.qr, /^<svg /)
  await app.waitFor(async () => (await app.texts('.topbar .needs-badge')).some((t) => /Phone/.test(t)), { label: 'Phone indicator in the top bar' })
  const state = await (await api(st.url, '/api/state')).json()
  assert.equal(state.approvals.length, 1)
  assert.equal(state.approvals[0].title, 'Do you want to proceed?')

  // open the page like a phone would (a real Chromium page: a web tile), and tap "Allow once"
  await app.eval((url) => (window as any).__fleetboard.useApp.getState().addNode({ type: 'web', x: 900, y: 0, w: 420, h: 800, data: { url } }), st.url)
  const page = await app.target((u) => u.startsWith(new URL(st.url).origin))
  const label = await app.waitFor(() => page.eval<string>(`[...document.querySelectorAll('.card button')].map(b => b.textContent).join('|')`), { label: 'phone page cards' })
  assert.match(label, /Allow once/)
  assert.match(await page.eval<string>(`document.querySelector('.card pre')?.textContent ?? ''`), /npm run deploy/)
  await page.eval(`[...document.querySelectorAll('.card button')].find(b => b.textContent === 'Allow once').click()`)
  await app.waitFor(() => app.fakeLog((e) => e.event === 'dialog-answer').length > 0, { label: 'answered from the phone' })
  assert.equal(app.fakeLog((e) => e.event === 'dialog-answer')[0].choice, 0)
  await app.waitStatus(id, 'idle')
  // the page refreshes itself
  await app.waitFor(() => page.eval<boolean>(`!document.querySelector('.card') && /Consoles/.test(document.body.textContent)`), { label: 'card gone on the phone' })
  page.close()
})

test("the Lead's question and the Ready card, from the phone", async () => {
  const url = (await app.invoke('remote:status')).url
  await app.invoke('fleet:startLead', { projectId, projectPath: repo, goal: 'add a.txt' })
  const ask = await app.waitFor(async () => (await (await api(url, '/api/state')).json()).asks[0], { label: 'question on the phone', timeout: 30_000 })
  assert.equal(ask.question, 'Ship to staging or prod?')
  assert.deepEqual(ask.options, ['Staging', 'Prod'])
  assert.equal((await api(url, '/api/ask', { method: 'POST', body: JSON.stringify({ askId: ask.id, answer: 'Staging' }) })).status, 200)
  assert.equal((await api(url, '/api/ask', { method: 'POST', body: JSON.stringify({ askId: ask.id, answer: 'Prod' }) })).status, 409, 'answered once')
  await app.waitFor(() => app.fakeLog((e) => e.event === 'answer' && /Staging/.test(e.text)).length, { label: 'lead got the answer' })

  const ready = await app.waitFor(async () => (await (await api(url, '/api/state')).json()).ready, { label: 'Ready on the phone', timeout: 30_000 })
  assert.equal(ready.lead, 'Lead')
  assert.equal((await api(url, '/api/merge', { method: 'POST', body: JSON.stringify({ projectId }) })).status, 400, 'merging needs an explicit confirm')
  const merged = await (await api(url, '/api/merge', { method: 'POST', body: JSON.stringify({ projectId, confirm: true }) })).json()
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')))
  assert.equal(git(sb, repo, 'status', '--porcelain'), '')
})

test('the API refuses what is not the phone page', async () => {
  const url = (await app.invoke('remote:status')).url
  assert.equal((await api(url, '/api/state', {}, '')).status, 401, 'no secret')
  assert.equal((await api(url, '/api/state', {}, 'f'.repeat(48))).status, 401, 'wrong secret')
  assert.equal((await api(url, '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403, 'another site')
  assert.equal((await api(url, '/api/answer', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415)
  const page = await api(url, '/', {}, '')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  assert.ok(!(await page.text()).includes(new URL(url).hash.slice(1)), 'the page never contains the secret')
})

test('a new link revokes the old one; turning it off closes the port', async () => {
  const old = (await app.invoke('remote:status')).url
  const fresh = (await app.invoke('remote:reset')).url
  assert.notEqual(fresh, old)
  assert.equal(new URL(fresh).port, new URL(old).port, 'same address, so a bookmark only needs the new secret')
  assert.equal((await api(old, '/api/state')).status, 401)
  assert.equal((await api(fresh, '/api/state')).status, 200)
  const off = await app.invoke('remote:disable')
  assert.equal(off.running, false)
  await app.waitFor(async () => !(await app.texts('.topbar .needs-badge')).some((t) => /Phone/.test(t)), { label: 'indicator gone' })
  await assert.rejects(api(fresh, '/api/state'))
})
