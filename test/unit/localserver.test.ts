import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSecret, refuse, sameSecret } from '../../src/main/localserver'

const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method }) as any

test('secrets are long, random and compared exactly', () => {
  const a = newSecret()
  assert.equal(a.length, 48)
  assert.notEqual(a, newSecret())
  assert.equal(sameSecret(a, a), true)
  assert.equal(sameSecret(a.slice(0, -1) + (a.endsWith('0') ? '1' : '0'), a), false)
  assert.equal(sameSecret(a.slice(1), a), false)
  assert.equal(sameSecret('', a), false)
  assert.equal(sameSecret(undefined, a), false)
})

test('what a CLI sends is accepted', () => {
  assert.equal(refuse(req({ host: '127.0.0.1:4000', 'content-type': 'application/json' }), 4000, { json: true }), null)
  assert.equal(refuse(req({ host: 'localhost:4000', 'content-type': 'application/json; charset=utf-8' }), 4000, { json: true }), null)
  assert.equal(refuse(req({ host: '127.0.0.1:4000', 'content-type': 'application/x-www-form-urlencoded' }), 4000), null, 'hooks post curl --data-binary')
})

test('what a web page can send is refused', () => {
  assert.ok(refuse(req({ host: '127.0.0.1:4000', origin: 'https://evil.example', 'content-type': 'application/json' }), 4000, { json: true }), 'any Origin')
  assert.ok(refuse(req({ host: '127.0.0.1:4000', origin: 'null', 'content-type': 'application/json' }), 4000, { json: true }), 'sandboxed frames send Origin: null')
  assert.ok(refuse(req({ host: 'evil.example:4000', 'content-type': 'application/json' }), 4000, { json: true }), 'DNS rebinding: a foreign Host')
  assert.ok(refuse(req({ host: '127.0.0.1:4001', 'content-type': 'application/json' }), 4000, { json: true }), 'another port')
  assert.ok(refuse(req({ host: '127.0.0.1:4000', 'content-type': 'text/plain' }), 4000, { json: true }), 'a simple (no preflight) content type')
  assert.ok(refuse(req({ host: '127.0.0.1:4000' }), 4000, { json: true }), 'no content type')
})
