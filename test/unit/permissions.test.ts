// Electron grants every permission it is not told to refuse. These two functions are the whole of
// what refuses, for the app's own window and for a page in a web tile — and a web tile's pages are
// the open web and, by design, the project's own dev server, running whatever an agent last wrote.
// Neither had a test, while the camera rule in one of them was a deliberate piece of hardening.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appPermission, mediaTypesOf, webPermission } from '../../src/main/permissions'

const LOCAL = 'http://localhost:5173/'

test("the app's own window gets the microphone and never the camera", () => {
  assert.equal(appPermission('media', ['audio']), true, 'push-to-talk')
  assert.equal(appPermission('media', ['video']), false)
  assert.equal(appPermission('media', ['audio', 'video']), false, 'asking for both is asking for the camera')
  // Electron does not always say which; push-to-talk has to keep working, and this is the app's own
  // page rather than a page off the web
  assert.equal(appPermission('media', undefined), true)
  assert.equal(appPermission('clipboard-read'), true)
  assert.equal(appPermission('notifications'), true)
  for (const p of ['openExternal', 'geolocation', 'serial', 'hid', 'usb', 'fileSystem', 'idle-detection', 'window-management', 'midi', 'pointerLock']) {
    assert.equal(appPermission(p), false, p)
  }
})

test('a page off the web gets nothing it could reach out of the tile with', () => {
  for (const p of ['fullscreen', 'clipboard-sanitized-write', 'pointerLock']) {
    assert.equal(webPermission(p, 'https://example.com/'), true, `${p} cannot reach anything`)
  }
  for (const p of ['openExternal', 'media', 'geolocation', 'clipboard-read', 'notifications', 'serial', 'hid', 'usb', 'fileSystem', 'idle-detection', 'window-management']) {
    assert.equal(webPermission(p, 'https://example.com/'), false, p)
  }
  // no url, an unparseable one, or one that only looks local
  for (const url of [undefined, '', 'not a url', 'http://localhost.evil.com/', 'http://127.0.0.1.evil.com/', 'http://notlocalhost/']) {
    assert.equal(webPermission('openExternal', url), false, String(url))
  }
})

test('a page on the machine the user controls gets the microphone and notifications, and still not the rest', () => {
  assert.equal(webPermission('media', LOCAL, ['audio']), true, 'a local dev app may record audio')
  assert.equal(webPermission('notifications', LOCAL), true)
  for (const url of [LOCAL, 'http://127.0.0.1:3000/x', 'http://[::1]:8080/']) {
    assert.equal(webPermission('notifications', url), true, url)
  }

  // the camera, which the app refuses to its own window, must not arrive this way instead
  assert.equal(webPermission('media', LOCAL, ['video']), false)
  assert.equal(webPermission('media', LOCAL, ['audio', 'video']), false)
  // and unlike the app's own window, a request that will not say is refused rather than trusted
  assert.equal(webPermission('media', LOCAL, undefined), false, 'no benefit of the doubt for a page')

  // openExternal hands a URL to the OS protocol handler: vscode://, ms-msdt:, anything registered
  assert.equal(webPermission('openExternal', LOCAL), false)
  for (const p of ['geolocation', 'clipboard-read', 'serial', 'hid', 'usb', 'fileSystem', 'idle-detection', 'window-management']) {
    assert.equal(webPermission(p, LOCAL), false, p)
  }
})

test('what Electron says about media is read in both of its shapes', () => {
  assert.deepEqual(mediaTypesOf({ mediaTypes: ['audio'] }), ['audio'], 'a request')
  assert.deepEqual(mediaTypesOf({ mediaType: 'video' }), ['video'], 'a check')
  assert.equal(mediaTypesOf({ mediaType: 'unknown' }), undefined, "'unknown' is not an answer")
  assert.equal(mediaTypesOf({ mediaTypes: [] }), undefined)
  assert.equal(mediaTypesOf(undefined), undefined)
  assert.equal(mediaTypesOf({}), undefined)
})
