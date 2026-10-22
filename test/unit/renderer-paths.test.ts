// The renderer's own path maths — no node:path in a browser context — used by both studios, the file
// tree, the file and doc nodes and the git view. `isInside` is the containment check behind Code
// studio's "Stay inside the project folder", so a Windows-only slip here is a real one, and the kind
// that shows up on one platform months later. It had no tests at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, dirname, isInside, joinPath, midTruncate, normalize, relativeTo, stripExt, toSlash } from '../../src/renderer/src/workbench/paths'

test('a Windows path comes back with forward slashes, which Windows takes everywhere', () => {
  assert.equal(toSlash('C:\\Users\\me\\repo'), 'C:/Users/me/repo')
  assert.equal(normalize('C:\\Users\\me\\.\\repo\\'), 'C:/Users/me/repo')
  assert.equal(normalize('\\\\server\\share\\dir'), '//server/share/dir')
  assert.equal(normalize('/a/b/'), '/a/b')
})

test('.. is resolved, and cannot climb out of an absolute path', () => {
  assert.equal(normalize('/a/b/../c'), '/a/c')
  assert.equal(normalize('/a/../../..'), '/', 'an absolute path has nowhere above the root to go')
  assert.equal(normalize('a/../../b'), '../b', 'a relative one does')
  assert.equal(normalize('C:/a/b/../../../c'), 'C:/c')
  assert.equal(normalize(''), '')
})

test('joinPath drops the empty parts a caller did not have', () => {
  assert.equal(joinPath('/root', 'src', 'a.ts'), '/root/src/a.ts')
  assert.equal(joinPath('/root', '', 'a.ts'), '/root/a.ts')
  assert.equal(joinPath('C:\\root', 'src/../lib', 'a.ts'), 'C:/root/lib/a.ts')
})

test('dirname of a drive root is the drive, not an empty string', () => {
  assert.equal(dirname('/a/b/c.ts'), '/a/b')
  assert.equal(dirname('/a'), '/')
  assert.equal(dirname('C:/a'), 'C:/', 'the drive itself')
  assert.equal(dirname('C:\\a\\b'), 'C:/a')
  assert.equal(dirname('/a/b/'), '/a')
})

test('baseName and stripExt take either separator', () => {
  assert.equal(baseName('C:\\dir\\file.test.ts'), 'file.test.ts')
  assert.equal(baseName('/dir/sub/'), 'sub', 'a trailing slash is not a name')
  assert.equal(baseName('file.md'), 'file.md')
  assert.equal(stripExt('file.test.ts'), 'file.test')
  assert.equal(stripExt('.gitignore'), '.gitignore', 'a dotfile is not an extension')
  assert.equal(stripExt('dir.v2/file'), 'dir.v2/file', 'and neither is a dot in a folder name')
})

test('containment is case-insensitive on Windows paths and exact elsewhere', () => {
  // the one that matters: this is what Code studio asks before writing
  assert.equal(isInside('/home/me/repo', '/home/me/repo/src/a.ts'), true)
  assert.equal(isInside('/home/me/repo', '/home/me/repo'), true, 'the root itself')
  assert.equal(isInside('/home/me/repo', '/home/me/repo-old/a.ts'), false, 'a sibling is not inside')
  assert.equal(isInside('/home/me/repo', '/home/me/repo/../other/a.ts'), false, 'nor is a way out through ..')
  assert.equal(isInside('/home/me/repo', '/home/me/REPO/a.ts'), false, 'POSIX names are case-sensitive')

  assert.equal(isInside('C:\\Users\\me\\repo', 'C:/Users/ME/Repo/src/a.ts'), true, 'Windows names are not')
  assert.equal(isInside('C:/Users/me/repo', 'C:/Users/me/repo-old/a.ts'), false)
  assert.equal(isInside('//server/share', '//SERVER/share/dir'), true, 'a UNC share compares the same way')
})

test('relativeTo gives a path inside the root, and leaves one outside alone', () => {
  assert.equal(relativeTo('/home/me/repo', '/home/me/repo/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo('/home/me/repo/', '/home/me/repo'), '', 'the root itself is the empty string')
  assert.equal(relativeTo('/home/me/repo', '/etc/passwd'), '/etc/passwd', 'outside: unchanged')
  assert.equal(relativeTo('C:\\Users\\me\\repo', 'C:/Users/ME/repo/src/a.ts'), 'src/a.ts', 'case-folded, and the real case kept')
  assert.equal(relativeTo('/home/me/repo', '/home/me/repo-old/a.ts'), '/home/me/repo-old/a.ts')
})

test('a long repo name is shortened in the middle, keeping the end', () => {
  assert.equal(midTruncate('owner/repo'), 'owner/repo')
  const long = midTruncate('LucioSiancas/Votelanding')
  assert.ok(long.length <= 26, long)
  assert.ok(long.endsWith('Votelanding'), long)
  const huge = midTruncate('a'.repeat(60), 20)
  assert.equal(huge.length, 20)
  assert.ok(huge.includes('…'))
})
