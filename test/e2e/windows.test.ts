// Windows: the platform layer for real (CI runs this on windows-latest). PowerShell consoles, an agent
// installed the npm way (a .cmd wrapper), closing a console ends its whole process tree, and local
// files load through fbfile:///C:/… . Skipped elsewhere.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

const WIN = process.platform === 'win32'
const opts = { skip: WIN ? false : 'Windows only' }

let app: App | null = null
let repo = ''
after(async () => {
  await app?.close()
})

async function ready() {
  if (app) return app
  const sb = makeSandbox()
  repo = makeRepo(sb)
  app = await App.launch({ sandbox: sb })
  await app.openProject(repo)
  return app
}

const spawn = (a: App, agentId: string, initialPrompt?: string) =>
  a.eval(({ agentId, initialPrompt }) => (window as any).__fleetboard.spawnConsoles({ agents: [agentId], initialPrompt })[0] as string, { agentId, initialPrompt })
const tail = (a: App, id: string) => a.eval((id) => (window as any).__fleetboard.consoleTail(id, 6000) as Promise<string>, id)
const pings = () => {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  return out.split('\n').filter((l) => /"PING\.EXE"/i.test(l)).length
}

test('a shell console is PowerShell and runs commands', opts, async () => {
  const a = await ready()
  const id = await spawn(a, 'shell', 'Write-Output ("WIN" + "_OK_" + (40 + 2))')
  const t = await a.waitFor(async () => ((await tail(a, id)).includes('WIN_OK_42') ? await tail(a, id) : null), { timeout: 30_000, label: 'PowerShell output' })
  assert.match(t, /WIN_OK_42/)
})

test('an agent installed the npm way (claude.cmd) starts in a console', opts, async () => {
  const a = await ready()
  const agents = await a.invoke('agents:detect', true)
  const claude = (agents as any[]).find((x) => x.id === 'claude')
  assert.match(String(claude?.path ?? ''), /claude\.cmd$/i, 'found through PATHEXT')
  const id = await spawn(a, 'claude')
  await a.waitFor(async () => /Fake Claude Code/.test(await tail(a, id)), { timeout: 30_000, label: 'the fake claude started' })
})

test('closing a console ends everything it started', opts, async () => {
  const a = await ready()
  const before = pings()
  const id = await spawn(a, 'shell', 'ping -n 600 127.0.0.1')
  await a.waitFor(() => pings() > before, { timeout: 30_000, label: 'ping running in the console' })
  await a.eval((id) => (window as any).__fleetboard.useApp.getState().removeNodes([id]), id)
  await a.waitFor(() => pings() === before, { timeout: 15_000, label: 'ping ended with its console' })
})

test('local files load through fbfile:///C:/…', opts, async () => {
  const a = await ready()
  const file = path.join(repo, 'pixel.txt')
  fs.writeFileSync(file, 'fleetboard on windows')
  const text = await a.eval(async (p) => {
    const url = `fbfile:///${encodeURI(p.replace(/\\/g, '/'))}`
    return (await fetch(url)).text()
  }, file)
  assert.equal(text, 'fleetboard on windows')
})
