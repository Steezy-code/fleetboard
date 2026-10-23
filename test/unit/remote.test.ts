import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.FLEETBOARD_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fb-remote-'))
const { findAddresses, checkRequest } = await import('../../src/main/remote')

const iface = (address: string, internal = false) => [{ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }] as any

test('picks the Tailscale address and a real LAN address, never a container bridge', () => {
  const found = findAddresses({ lo: iface('127.0.0.1', true), docker0: iface('172.17.0.1'), 'br-12ab': iface('172.18.0.1'), tailscale0: iface('100.101.102.103'), wlp2s0: iface('192.168.1.20') })
  assert.deepEqual(found, { tailscale: '100.101.102.103', lan: '192.168.1.20' })
  assert.deepEqual(findAddresses({ eth0: iface('8.8.8.8'), docker0: iface('172.17.0.1') }), { tailscale: undefined, lan: undefined }, 'a public address is not a LAN')
  assert.equal(findAddresses({ x: iface('100.63.0.1') }).tailscale, undefined, '100.63 is outside 100.64/10')
  // 100.64/10 is shared address space, not Tailscale's: a CGNAT ISP or a hotspot hands one out on a
  // real interface, and calling that "encrypted" in Settings is the dangerous way to be wrong
  assert.equal(findAddresses({ wlp2s0: iface('100.90.1.2') }).tailscale, undefined, 'a CGNAT Wi-Fi address is not Tailscale')
  assert.equal(findAddresses({ ppp0: iface('100.70.0.5') }).tailscale, undefined, 'nor a mobile broadband one')
  assert.equal(findAddresses({ eth0: iface('100.80.0.9') }).tailscale, undefined, 'nor a CGNAT ethernet link')
  // Windows names the adapter "Tailscale"; Linux calls it tailscale0
  assert.equal(findAddresses({ Tailscale: iface('100.101.102.103') }).tailscale, '100.101.102.103', 'Windows adapter name')
  assert.equal(findAddresses({ tailscale1: iface('100.101.102.104') }).tailscale, '100.101.102.104')
  // the right name with the wrong range is not it either
  assert.equal(findAddresses({ tailscale0: iface('192.168.1.5') }).tailscale, undefined, 'a tailscale0 outside the range')
})

const HOST = '100.101.102.103:4321'
const TOKEN = 'a'.repeat(48)
const req = (headers: Record<string, string>, method = 'GET') => ({ method, headers: { host: HOST, ...headers } })

test('the page itself needs no secret, only the right Host', () => {
  assert.equal(checkRequest(req({}), HOST, TOKEN, false), null)
  assert.equal(checkRequest(req({ host: 'evil.example:4321' }), HOST, TOKEN, false), 421, 'DNS rebinding')
})

test('the API needs the secret, its own origin and JSON', () => {
  const auth = { authorization: `Bearer ${TOKEN}` }
  assert.equal(checkRequest(req(auth), HOST, TOKEN, true), null)
  assert.equal(checkRequest(req({ ...auth, origin: `http://${HOST}`, 'content-type': 'application/json' }, 'POST'), HOST, TOKEN, true), null)
  assert.equal(checkRequest(req({}), HOST, TOKEN, true), 401)
  assert.equal(checkRequest(req({ authorization: `Bearer ${'b'.repeat(48)}` }), HOST, TOKEN, true), 401)
  assert.equal(checkRequest(req({ ...auth, origin: 'https://evil.example' }), HOST, TOKEN, true), 403)
  assert.equal(checkRequest(req({ ...auth, 'content-type': 'text/plain' }, 'POST'), HOST, TOKEN, true), 415)
})

test('the Inbox follows its network: it listens once Tailscale is up, says so when it goes away, and never churns', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = (await import('node:os')).default
  const { mock } = await import('node:test')
  const { register, followAddress, remoteStatus } = await import('../../src/main/remote')
  fs.writeFileSync(path.join(process.env.FLEETBOARD_HOME!, 'remote.json'), JSON.stringify({ enabled: true, network: 'tailscale', token: TOKEN, port: 0 }))
  let ifaces: Record<string, any> = { lo: iface('127.0.0.1', true) }
  mock.method(os, 'networkInterfaces', () => ifaces)
  const handlers = new Map<string, (...a: any[]) => any>()
  const events: string[] = []
  await register({ ipc: { handle: (ch: string, fn: any) => handlers.set(ch, fn) }, emit: (ch: string) => events.push(ch), ptys: {} } as any)

  // the app started at login, before Tailscale connected
  assert.equal(remoteStatus().running, false)
  assert.match(remoteStatus().error ?? '', /Tailscale is not running/)
  assert.equal(await followAddress(), false, 'nothing changed: nothing restarted')
  // Tailscale connects: it tries that address (this machine cannot really listen on it)
  ifaces = { ...ifaces, tailscale0: iface('100.101.102.103') }
  assert.equal(await followAddress(), true)
  assert.match(remoteStatus().error ?? '', /Could not listen on 100\.101\.102\.103/)
  assert.ok(events.includes('remote:changed'), 'the Settings panel hears of it')
  // and gone again
  ifaces = { lo: iface('127.0.0.1', true) }
  assert.equal(await followAddress(), true)
  assert.match(remoteStatus().error ?? '', /Tailscale is not running/)

  // a running Inbox whose address holds is left alone
  const st = await handlers.get('remote:enable')!({}, 'local')
  assert.equal(st.running, true)
  assert.equal(await followAddress(), false)
  assert.equal(remoteStatus().url, st.url, 'same address and port')
  const page = await fetch(new URL(st.url).origin + '/')
  assert.equal(page.status, 200)

  // turned on and straight off again: it ends off, whatever order the starts finish in
  const [, off] = await Promise.all([handlers.get('remote:enable')!({}, 'local'), handlers.get('remote:disable')!({})])
  assert.equal(off.running, false)
  assert.equal(remoteStatus().running, false)
  await assert.rejects(fetch(new URL(st.url).origin + '/'), 'nothing listens')
  mock.restoreAll()
})

test('a request body that is too big is refused, and the server keeps answering', async () => {
  const { register, remoteStatus } = await import('../../src/main/remote')
  const handlers = new Map<string, (...a: any[]) => any>()
  await register({ ipc: { handle: (ch: string, fn: any) => handlers.set(ch, fn) }, emit: () => {}, ptys: {} } as any)
  const st = await handlers.get('remote:enable')!({}, 'local')
  const u = new URL(st.url)
  const r = await fetch(`${u.origin}/api/ask`, { method: 'POST', headers: { Authorization: `Bearer ${u.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: 'x'.repeat(200_000) }).catch((e) => e)
  assert.ok(r instanceof Error || r.status >= 400, 'refused')
  // the server still answers
  assert.equal((await fetch(`${u.origin}/`)).status, 200)
  await handlers.get('remote:disable')!({})
  assert.equal(remoteStatus().running, false)
})

test('one peer guessing the secret cannot lock the user out of their own Inbox', async () => {
  const { lockedOut, wrongSecret, authorized } = await import('../../src/main/remote')
  const attacker = '192.168.1.50'
  const phone = '192.168.1.9'

  for (let i = 0; i < 40; i++) wrongSecret(attacker)
  assert.equal(lockedOut(attacker), true, 'it still slows a guesser down')
  assert.equal(lockedOut(phone), false, "and says nothing about anyone else's requests")

  // a few wrong tries of its own (a stale link, a mistyped token) must not stick once it gets in
  for (let i = 0; i < 29; i++) wrongSecret(phone)
  assert.equal(lockedOut(phone), false)
  authorized(phone)
  for (let i = 0; i < 29; i++) wrongSecret(phone)
  assert.equal(lockedOut(phone), false, 'the earlier ones were forgotten, so 29 more are still 29')

  // and a flood of peers cannot grow the table without end
  for (let i = 0; i < 1500; i++) wrongSecret(`10.0.${Math.floor(i / 250)}.${i % 250}`)
  assert.equal(lockedOut(attacker), true, 'the peers already being counted still are')
})
