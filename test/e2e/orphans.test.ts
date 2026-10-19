// The app dies without closing its consoles: a console whose program ignores the hangup the system
// sends would run on, unseen. The next launch ends it before anything else starts.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { App, makeRepo, makeSandbox } from './harness'

let app: App | undefined
let stray: number | undefined
after(async () => {
  await app?.close()
  if (stray)
    try {
      process.kill(-stray, 'SIGKILL')
    } catch {
      /* gone */
    }
})

const running = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}

test('after the app is killed, the next launch ends the consoles it left running', { skip: !fs.existsSync('/proc/self/stat') && 'reads /proc' }, async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb)
  app = await App.launch({ sandbox: sb })
  await app.openProject(repo)
  const [quiet, normal] = await app.eval(() => (window as any).__fleetboard.spawnConsoles({ agents: ['shell', 'shell'] }) as string[])
  await app.waitFor(async () => (await app!.invoke('pty:list')).length === 2, { label: 'two consoles' })
  // one ignores the hangup, as Gemini CLI does
  await app.eval((id) => (window as any).fb.send('pty:write', id, "trap '' HUP; exec sleep 600\r"), quiet)
  const pids = Object.fromEntries((await app.invoke('pty:list')).map((p: any) => [p.id, p.pid]))
  stray = pids[quiet]
  await app.waitFor(() => fs.readFileSync(`/proc/${pids[quiet]}/cmdline`, 'utf8').startsWith('sleep'), { label: 'sleeping' })

  assert.equal(await app.killHard(), true)
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(running(pids[normal]), false, 'a shell ends with its terminal')
  assert.equal(running(pids[quiet]), true, 'the one that ignores the hangup runs on')

  app = await App.launch({ sandbox: sb })
  await app.waitFor(() => !running(pids[quiet]), { label: 'left-over console ended', timeout: 5000 })
  assert.match(fs.readFileSync(`${sb.fbHome}/logs/main.log`, 'utf8'), /stopped 1 console process the last run left running/)
})
