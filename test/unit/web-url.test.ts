// What a web tile will navigate to. node.data.url is persisted in the board file and re-mounted as
// the webview's src on every load, so this is not only about what someone types into the URL bar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipc } from '../support/renderer-env'

const { normalizeUrl, loadsOnOpen } = await import('@/nodes/WebNode')
void ipc

test('the shortcuts people actually type', () => {
  assert.equal(normalizeUrl('3000'), 'http://localhost:3000')
  assert.equal(normalizeUrl(':5173/app'), 'http://localhost:5173/app')
  assert.equal(normalizeUrl('localhost:8080'), 'http://localhost:8080')
  assert.equal(normalizeUrl('127.0.0.1:1234/x'), 'http://127.0.0.1:1234/x')
  assert.equal(normalizeUrl('192.168.1.10:3000'), 'http://192.168.1.10:3000')
  assert.equal(normalizeUrl('example.com'), 'https://example.com')
  assert.equal(normalizeUrl('example.com/a/b?c=d'), 'https://example.com/a/b?c=d')
  assert.equal(normalizeUrl('  '), '')
})

test('a full URL of a scheme a tile should show is passed through', () => {
  for (const u of ['https://example.com/x', 'http://localhost:3000/', 'file:///home/me/dist/index.html', 'about:blank', 'data:text/plain,hello']) {
    assert.equal(normalizeUrl(u), u, u)
  }
})

test('any other scheme is searched for, never navigated to', () => {
  // the old check accepted anything shaped like a scheme, so these reached the webview as written —
  // and an external-protocol navigation is handed to the OS handler registered for it
  for (const u of ['vscode://file/etc/passwd', 'slack://channel?id=x', 'ms-msdt:/id', 'calculator://', 'steam://run/1', 'zoommtg://zoom.us/join']) {
    const out = normalizeUrl(u)
    assert.match(out, /^https:\/\/www\.google\.com\/search\?q=/, `${u} must not be navigated to`)
    assert.ok(!out.startsWith(u.split(':')[0] + ':'), u)
  }
  // Chromium's own pages have no business in a dev-server tile
  assert.match(normalizeUrl('chrome://settings'), /^https:\/\/www\.google\.com\/search/)
  // and a plain search still searches
  assert.match(normalizeUrl('how do I center a div'), /^https:\/\/www\.google\.com\/search\?q=how/)
})

test('javascript: is never navigated to', () => {
  // it has no "//" and no dot, so it already fell through to the search branch; pin that
  for (const u of ['javascript:alert(1)', 'javascript://comment%0Aalert(1)']) {
    assert.match(normalizeUrl(u), /^https:\/\/www\.google\.com\/search/, u)
  }
})

test('a board file can only make a tile load a web page by itself; local files and inline pages wait for a click', () => {
  for (const u of ['https://example.com', 'http://localhost:5173/', 'about:blank']) assert.equal(loadsOnOpen(u), true, u)
  for (const u of ['file:///home/me/secret.txt', 'data:text/html,<p>x</p>', 'blob:https://x/1', 'about:srcdoc', '']) assert.equal(loadsOnOpen(u), false, u)
})
