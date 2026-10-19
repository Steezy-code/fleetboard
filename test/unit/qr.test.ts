// The QR encoder against an independent encoder (python-qrcode, module by module with forced version,
// error level and mask) and against a real decoder (OpenCV read our own automatic choices back to the
// text when the fixture was made: see test/fixtures/qr-reference.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { qrEncode, qrSvg } from '../../src/shared/qr'

interface Ref {
  text: string
  ecc: 'L' | 'M'
  version: number
  mask?: number
  auto?: boolean
  size: number
  rows?: string[]
}
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../fixtures/qr-reference.json'), 'utf8')) as { reference: Ref[]; decoded: Ref[] }
const hex = (m: boolean[][]) => m.map((r) => BigInt('0b' + r.map((v) => (v ? '1' : '0')).join('')).toString(16).padStart(Math.ceil(r.length / 4), '0'))

test('every version, error level and mask matches python-qrcode module for module', () => {
  const fixed = fixture.reference.filter((c) => !c.auto)
  assert.ok(fixed.length > 200, `${fixed.length} cases`)
  for (const c of fixed) assert.deepEqual(hex(qrEncode(c.text, { ecc: c.ecc, version: c.version, mask: c.mask })), c.rows, `${c.ecc} v${c.version} mask ${c.mask}: ${c.text.slice(0, 30)}`)
})

test('automatic choice: the smallest version that fits', () => {
  for (const c of fixture.reference.filter((x) => x.auto)) assert.equal(qrEncode(c.text, { ecc: c.ecc }).length, c.size, `${c.ecc}: ${c.text.slice(0, 30)}`)
})

test('codes a real decoder read back are produced unchanged', () => {
  assert.ok(fixture.decoded.length >= 10)
  for (const c of fixture.decoded) assert.deepEqual(hex(qrEncode(c.text, { ecc: c.ecc })), c.rows, `${c.ecc}: ${c.text.slice(0, 30)}`)
})

test('too long is an error, not a broken code', () => {
  assert.throws(() => qrEncode('x'.repeat(300)), /too long/)
})

test('svg has a quiet zone and one dark path', () => {
  const svg = qrSvg('hello', 100)
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/)
  assert.equal((svg.match(/<path /g) ?? []).length, 1)
})
