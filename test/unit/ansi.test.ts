// Terminal output to plain text. It runs in the main process on whole CI logs, so besides reading
// ordinary sequences right it must stay linear on text that never closes one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripAnsi } from '../../src/shared/ansi'

test('ordinary sequences are removed and the text kept', () => {
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m plain'), 'red plain')
  assert.equal(stripAnsi('\x1b]0;title\x07after'), 'after', 'OSC ended by BEL')
  assert.equal(stripAnsi('\x1b]8;;https://x.invalid\x1b\\link\x1b]8;;\x1b\\'), 'link', 'OSC 8 hyperlinks, ended by ESC \\')
  assert.equal(stripAnsi('a\x1bPq#0;2;0;0;0\x1b\\b'), 'ab', 'DCS')
  assert.equal(stripAnsi('x\x1b[5Cy'), 'x     y', 'cursor-forward drawn as spaces')
  assert.equal(stripAnsi('line\r\n'), 'line\n')
})

test('an OSC that is never closed ends at the next escape, and costs linear time', () => {
  assert.equal(stripAnsi('a\x1b]0;unterminated\x1b[1mbold'), 'abold')
  const hostile = 'x\x1b]'.repeat(100_000)
  const t = Date.now()
  stripAnsi(hostile)
  stripAnsi('\x1bP'.repeat(100_000))
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`)
})
