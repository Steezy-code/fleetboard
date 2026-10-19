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
