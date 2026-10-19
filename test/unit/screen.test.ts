import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TermScreen } from '../../src/main/screen'

async function screenOf(data: string, cols = 40, rows = 6) {
  const s = new TermScreen(cols, rows)
  s.write(data)
  await s.flush()
  return s
}

test('absolute column moves become spaces, like a terminal shows them', async () => {
  const s = await screenOf('\x1b[2GChoose\x1b[9Gthe\x1b[13Gtext')
  assert.equal(s.view().lines[0], ' Choose the text')
})

test('erased text is gone from the screen', async () => {
  const s = await screenOf('Do you want to proceed?\r\n❯ 1. Yes\x1b[1A\r\x1b[0J$ done')
  assert.deepEqual(s.view().lines.filter((l) => l.trim()), ['$ done'])
})

test('cursor visibility follows DECTCEM and a full reset', async () => {
  const s = await screenOf('\x1b[?25l')
  assert.equal(s.view().cursorHidden, true)
  s.write('\x1b[?25h')
  await s.flush()
  assert.equal(s.view().cursorHidden, false)
  s.write('\x1b[?1049h\x1b[?25l')
  await s.flush()
  assert.deepEqual([s.view().alt, s.view().cursorHidden], [true, true])
  s.write('\x1bc')
  await s.flush()
  assert.equal(s.view().cursorHidden, false)
})

test('cursor position', async () => {
  const s = await screenOf('one\r\ntwo\r\nthr')
  assert.deepEqual([s.view().cursorX, s.view().cursorY], [3, 2])
})

test('text() joins soft-wrapped rows and includes scrollback', async () => {
  const s = new TermScreen(10, 3)
  s.write('0123456789abcdef\r\n')
  for (let i = 0; i < 6; i++) s.write(`line ${i}\r\n`)
  await s.flush()
  const text = s.text()
  assert.ok(text.startsWith('0123456789abcdef\n'), text)
  assert.ok(text.endsWith('line 5'), text)
  assert.equal(text.split('\n').length, 7)
})

test('text() keeps the newest characters', async () => {
  const s = await screenOf(Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\r\n'))
  assert.equal(s.text(12), 'ow 18\nrow 19')
})

test('wide characters take two cells', async () => {
  const s = await screenOf('漢字ok')
  assert.equal(s.view().lines[0], '漢字ok')
  assert.equal(s.view().cursorX, 6)
})

test('resize follows the console and ignores the 0×0 of a hidden node', async () => {
  const s = await screenOf('hello')
  s.resize(80, 24)
  s.resize(0, 0)
  s.resize(-3, 10)
  assert.deepEqual([s.cols, s.rows], [80, 24])
  assert.equal(s.view().lines.length, 24)
  assert.equal(s.view().lines[0], 'hello')
})

test('a large burst parses quickly', async () => {
  const s = new TermScreen(100, 30)
  const chunk = '\x1b[38;2;10;20;30mcolored \x1b[1mbold\x1b[0m text\r\n'.repeat(2000)
  const t0 = performance.now()
  s.write(chunk)
  await s.flush()
  assert.ok(performance.now() - t0 < 1500, `${performance.now() - t0}ms`)
})
