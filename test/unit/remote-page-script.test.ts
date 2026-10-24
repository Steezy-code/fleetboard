import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { PAGE_HTML } from '../../src/main/remote-page'
test('phone page inline scripts parse after TypeScript template-string escaping', () => {
  const scripts = [...PAGE_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length)
  for (const [, source] of scripts) assert.doesNotThrow(() => new Script(source!))
})
