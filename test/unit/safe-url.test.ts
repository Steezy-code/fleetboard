import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeUrl } from '@/workbench/markdown'

test('links people write are kept as written', () => {
  for (const u of ['https://example.com/a?b#c', 'http://localhost:3000', 'mailto:a@b.c', 'src/a.ts', '../docs/x.md#part', './img.png', '#heading', 'my notes/file.md', '/abs/path.md']) {
    assert.equal(safeUrl(u, 'href'), u, u)
  }
})

test('every way of writing a script URL is refused', () => {
  for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:x', '\u0001javascript:x', '\u0000javascript:x', 'vbscript:x', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'fbfile:///etc/passwd', 'chrome://settings', 'ms-msdt:foo', 'jav&#x09;ascript:x'.replace('&#x09;', '\t')]) {
    assert.equal(safeUrl(u, 'href'), null, JSON.stringify(u))
  }
})

test('images: local files through fbfile and inline raster data only', () => {
  assert.equal(safeUrl('fbfile:///home/me/a.png', 'src'), 'fbfile:///home/me/a.png')
  assert.equal(safeUrl('data:image/png;base64,AAAA', 'src'), 'data:image/png;base64,AAAA')
  assert.equal(safeUrl('data:image/svg+xml;base64,AAAA', 'src'), null, 'SVG can carry script')
  assert.equal(safeUrl('java\tscript:x', 'src'), null)
})
