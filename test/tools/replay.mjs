#!/usr/bin/env node
// Print what the terminal showed at each mark of an asciicast recording (and at the end).
//   node test/tools/replay.mjs file.cast [--all]   (--all: also print every 'i' input event)
import fs from 'node:fs'
import xterm from '@xterm/xterm'

const [file, flag] = process.argv.slice(2)
const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
const header = JSON.parse(lines[0])
const term = new xterm.Terminal({ cols: header.width, rows: header.height, scrollback: 0, allowProposedApi: true })
const write = (d) => new Promise((r) => term.write(d, r))
const screen = () => {
  const b = term.buffer.active
  const out = []
  for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}
for (const l of lines.slice(1)) {
  const [t, kind, data] = JSON.parse(l)
  if (kind === 'o') await write(data)
  else if (kind === 'm') console.log(`\n===== mark "${data}" @ ${t.toFixed(1)}s =====\n${screen()}`)
  else if (kind === 'i' && flag === '--all') console.log(`----- input ${JSON.stringify(data)} @ ${t.toFixed(1)}s`)
}
console.log(`\n===== end =====\n${screen()}`)
