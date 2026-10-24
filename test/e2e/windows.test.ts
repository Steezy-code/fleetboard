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
  // what the console's Close button does
  await a.invoke('pty:kill', id)
  await a.waitFor(() => pings() === before, { timeout: 15_000, label: 'ping ended with its console' })
})

test('local images load through fbfile:///C:/…', opts, async () => {
  const a = await ready()
  // a 1×1 PNG, in a folder with a space like many Windows paths
  const file = path.join(repo, 'my images', 'pixel.png')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  const loaded = await a.eval(
    (p) =>
      new Promise<string>((resolve) => {
        // as lib/api.ts fileUrl() builds it
        const s = p.replace(/\\/g, '/')
        const img = new Image()
        img.onload = () => resolve(`loaded ${img.naturalWidth}x${img.naturalHeight}`)
        img.onerror = () => resolve('error')
        img.src = `fbfile://${encodeURI(s.startsWith('/') ? s : `/${s}`)}`
      }),
    file
  )
  assert.equal(loaded, 'loaded 1x1')
})

test('pausing a console really freezes it, and the tile says so', opts, async () => {
  const a = await ready()
  // a counter in the console's own shell: its output is the only honest proof that it stopped
  const id = await spawn(a, 'shell', '$i = 0; while ($true) { $i++; Write-Output "TICK$i"; Start-Sleep -Milliseconds 200 }')
  const ticks = async () => ((await tail(a, id)).match(/TICK\d+/g) ?? []).length
  const statusOf = () => a.eval((i) => (window as any).__fleetboard.useApp.getState().statuses[i] as string, id)
  await a.waitFor(async () => ((await ticks()) > 3 ? true : null), { timeout: 30_000, label: 'the console counting' })

  await a.invoke('pty:pause', id)
  await a.waitFor(async () => ((await statusOf()) === 'paused' ? true : null), { timeout: 20_000, label: 'the tile reads paused' })
  // the freeze is one PowerShell call away: let it land before deciding whether it took
  await new Promise((r) => setTimeout(r, 3000))
  const frozen = await ticks()
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(await ticks(), frozen, 'a paused console prints nothing more')

  await a.invoke('pty:resume', id)
  await a.waitFor(async () => ((await ticks()) > frozen ? true : null), { timeout: 20_000, label: 'counting again after resume' })
  assert.notEqual(await statusOf(), 'paused')
})

test('closing a paused console still ends what it started', opts, async () => {
  const a = await ready()
  const before = pings()
  const id = await spawn(a, 'shell', 'ping -n 600 127.0.0.1')
  await a.waitFor(() => pings() > before, { timeout: 30_000, label: 'ping running in the console' })
  await a.invoke('pty:pause', id)
  // frozen, with a child of its own mid-flight: taskkill /F has to end it anyway
  await new Promise((r) => setTimeout(r, 3000))
  await a.invoke('pty:kill', id)
  await a.waitFor(() => pings() <= before, { timeout: 30_000, label: 'the frozen tree ended' })
})
