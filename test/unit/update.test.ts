// Is there a newer Fleetboard than the one running? The comparison is the whole feature: a wrong
// answer either nags about a version the user already has, or tells them they are current while a
// release with their fix in it sits there. Releases here are tagged v0.2.0 and v0.2.0-win.1, so
// prereleases have to order below the release they lead to, the way semver says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, interpret, newerRelease, newestRelease } from '../../src/main/update'

const order = (a: string, b: string) => Math.sign(compareVersions(a, b))

test('a newer release wins, in every field', () => {
  assert.equal(order('0.2.0', '0.1.0'), 1)
  assert.equal(order('0.1.1', '0.1.0'), 1)
  assert.equal(order('1.0.0', '0.9.9'), 1)
  assert.equal(order('0.10.0', '0.9.0'), 1, 'ten is after nine, not before it alphabetically')
  assert.equal(order('0.1.0', '0.1.0'), 0)
  assert.equal(order('0.1.0', '0.2.0'), -1)
})

test('a prerelease comes before the release it leads to', () => {
  assert.equal(order('0.1.0-win.1', '0.1.0'), -1)
  assert.equal(order('0.1.0', '0.1.0-win.1'), 1)
  assert.equal(order('0.1.0-win.2', '0.1.0-win.1'), 1)
  assert.equal(order('0.1.0-merge-review.1', '0.1.0'), -1, 'what is installed now is older than 0.1.0 itself')
  assert.equal(order('0.2.0-win.1', '0.1.0'), 1, 'a prerelease of a later version is still later')
})

test('a tag is read with or without its v, and junk compares as nothing', () => {
  assert.equal(order('v0.2.0', '0.1.0'), 1)
  assert.equal(order('0.2.0', 'v0.1.0'), 1)
  assert.equal(order('', '0.1.0'), -1)
  assert.equal(order('not a version', '0.1.0'), -1)
})

test('a release is read from what GitHub lists, and anything missing makes it no release', () => {
  const r = newestRelease('[{"tag_name":"v0.2.0","name":"0.2.0","html_url":"https://github.com/o/r/releases/tag/v0.2.0","published_at":"2026-10-24T00:00:00Z","prerelease":false,"draft":false}]')
  assert.deepEqual(r, { tag: 'v0.2.0', name: '0.2.0', url: 'https://github.com/o/r/releases/tag/v0.2.0', publishedAt: '2026-10-24T00:00:00Z', prerelease: false })
  assert.equal(newestRelease('not json'), null)
  assert.equal(newestRelease('[]'), null, 'a repo with no releases')
  assert.equal(newestRelease('[{}]'), null, 'no tag is no release')
  assert.equal(newestRelease('[{"tag_name":"v0.2.0"}]')?.url, '', 'a tag with no url is still a release')
})

// the bug this fixes: `gh release view` answers with the latest NON-prerelease, and this project tags
// its Windows builds `v0.2.0-win.1`. On a repo that has only ever published prereleases it said
// "release not found", so the chip could never appear.
test('a prerelease is a release: a repo with only prereleases still offers an update', () => {
  const only = '[{"tag_name":"v0.1.0-win.1","html_url":"https://github.com/o/r/releases/tag/v0.1.0-win.1","prerelease":true,"draft":false}]'
  assert.equal(newestRelease(only)?.tag, 'v0.1.0-win.1')
  assert.equal(newestRelease(only)?.prerelease, true)
  assert.equal(newerRelease('0.1.0-merge-review.1', newestRelease(only))?.tag, 'v0.1.0-win.1', 'what is installed now is behind it')
})

test('a draft is not a release anyone can download, so it is never offered', () => {
  const list = '[{"tag_name":"v0.3.0","draft":true},{"tag_name":"v0.2.0","html_url":"https://github.com/o/r/releases/tag/v0.2.0","draft":false}]'
  assert.equal(newestRelease(list)?.tag, 'v0.2.0')
  assert.equal(newestRelease('[{"tag_name":"v0.3.0","draft":true}]'), null, 'drafts only is no release')
})

test('the highest version wins, not whichever was published last', () => {
  const list = '[{"tag_name":"v0.1.1","draft":false,"published_at":"2026-10-24T00:00:00Z"},{"tag_name":"v0.2.0","draft":false,"published_at":"2026-10-20T00:00:00Z"}]'
  assert.equal(newestRelease(list)?.tag, 'v0.2.0')
  assert.equal(newerRelease('0.2.0', newestRelease(list)), null, 'and so a 0.2.0 build is not told to downgrade')
})

test('a url GitHub did not give is not offered as one', () => {
  assert.equal(newestRelease('[{"tag_name":"v0.2.0","html_url":"javascript:alert(1)","draft":false}]')?.url, '')
  assert.equal(newestRelease('[{"tag_name":"v0.2.0","html_url":"file:///etc/passwd","draft":false}]')?.url, '')
  assert.equal(newestRelease('[{"tag_name":"v0.2.0","html_url":"https://github.com/o/r/releases/tag/v0.2.0","draft":false}]')?.url, 'https://github.com/o/r/releases/tag/v0.2.0')
})

test('only a release that is actually newer is one to offer', () => {
  const rel = (tag: string, prerelease = false) => ({ tag, name: tag, url: `https://github.com/o/r/releases/tag/${tag}`, publishedAt: '', prerelease })
  assert.equal(newerRelease('0.1.0', rel('v0.2.0'))?.tag, 'v0.2.0')
  assert.equal(newerRelease('0.1.0', rel('v0.1.0')), null, 'the one you are running is not an update')
  assert.equal(newerRelease('0.2.0', rel('v0.1.0')), null, 'a build ahead of the last release is not behind it')
  assert.equal(newerRelease('0.1.0-merge-review.1', rel('v0.1.0'))?.tag, 'v0.1.0', 'a prerelease build is behind the release')
  assert.equal(newerRelease('0.1.0', null), null)
})

test('a repo with no releases yet is not an error, and not an update', () => {
  const out = interpret('0.1.0', { code: 0, stdout: '[]', stderr: '\n' })
  assert.deepEqual(out, { current: '0.1.0', latest: null, newer: null })
})

test('not being signed in says so, and a real failure says what gh said', () => {
  assert.match(interpret('0.1.0', { code: 4, stdout: '', stderr: 'gh auth login required' }).error ?? '', /gh auth login/)
  assert.equal(interpret('0.1.0', { code: 1, stdout: '', stderr: 'could not resolve host\nmore' }).error, 'could not resolve host')
  assert.equal(interpret('0.1.0', { code: 1, stdout: '', stderr: '' }).error, 'gh failed')
})

test('a release GitHub listed is read, and compared to this build', () => {
  const stdout = '[{"tag_name":"v0.2.0","name":"0.2.0","html_url":"https://github.com/Steezy-code/fleetboard/releases/tag/v0.2.0","published_at":"2026-10-24T00:00:00Z","prerelease":false,"draft":false}]'
  assert.equal(interpret('0.1.0-merge-review.1', { code: 0, stdout, stderr: '' }).newer?.tag, 'v0.2.0')
  assert.equal(interpret('0.3.0', { code: 0, stdout, stderr: '' }).newer, null)
  assert.equal(interpret('0.3.0', { code: 0, stdout, stderr: '' }).latest?.tag, 'v0.2.0', 'the latest release is still reported')
})
