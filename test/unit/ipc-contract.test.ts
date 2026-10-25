import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INVOKE_CHANNELS, SEND_CHANNELS, validateIpc } from '../../src/shared/ipc'
import { trustedSender } from '../../src/main/ipc'

test('every main handler has an explicit preload allowlist entry', () => {
  const source = fs.readdirSync('src/main').filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(`src/main/${f}`, 'utf8')).join('\n')
  for (const m of source.matchAll(/\bipc(?:Main)?\.(handle|on)\(\s*'([^']+)'/g)) assert.ok((m[1] === 'handle' ? INVOKE_CHANNELS : SEND_CHANNELS).includes(m[2] as never), m[2])
})
test('dangerous malformed requests are refused before dispatch', () => {
  for (const [channel, args] of [['unknown:command', []], ['goal:check', ['/tmp', {}]], ['pty:resize', ['id', Infinity, 20]], ['cli:run', [{ prompt: 'hello' }]], ['store:setGlobal', ['__proto__', {}]], ['remote:enable', ['all']], ['recovery:apply', [null]]] as [string, unknown[]][]) assert.throws(() => validateIpc(channel, args))
  validateIpc('goal:check', ['/tmp', 'npm test'])
  validateIpc('pty:resize', ['id', 80, 24])
})
test('web tiles and child frames cannot call privileged IPC', () => {
  const mainFrame = {}
  const sender = { mainFrame }
  const win = { isDestroyed: () => false, webContents: sender } as any
  assert.equal(trustedSender({ sender, senderFrame: mainFrame } as any, win), true)
  assert.equal(trustedSender({ sender, senderFrame: {} } as any, win), false)
  assert.equal(trustedSender({ sender: {}, senderFrame: mainFrame } as any, win), false)
  assert.equal(trustedSender({ sender, senderFrame: mainFrame } as any, null), false)
})

test('every invoke channel is typed, or one of the frozen legacy ones: a new channel goes into IpcContract', async () => {
  const { UNTYPED_CHANNELS } = await import('../../src/shared/ipc-contract')
  const typed = new Set([...fs.readFileSync('src/shared/ipc-contract.ts', 'utf8').matchAll(/^\s*'([a-z]+:[A-Za-z]+)': \{ args/gm)].map((m) => m[1]!))
  for (const c of INVOKE_CHANNELS) assert.ok(typed.has(c) || UNTYPED_CHANNELS.includes(c), `${c}: add it to IpcContract (shared/ipc-contract.ts)`)
  for (const c of UNTYPED_CHANNELS) assert.ok(!typed.has(c), `${c} is typed now: take it off UNTYPED_CHANNELS`)
  for (const c of UNTYPED_CHANNELS) assert.ok((INVOKE_CHANNELS as readonly string[]).includes(c), `${c} is no channel any more: take it off UNTYPED_CHANNELS`)
  // the list only shrinks
  assert.ok(UNTYPED_CHANNELS.length <= 81, `UNTYPED_CHANNELS grew to ${UNTYPED_CHANNELS.length}`)
})

test('a typed channel is called through request(), not invoke()', () => {
  const typed = [...fs.readFileSync('src/shared/ipc-contract.ts', 'utf8').matchAll(/^\s*'([a-z]+:[A-Za-z]+)': \{ args/gm)].map((m) => m[1]!)
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []))
  for (const file of walk('src/renderer/src')) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\binvoke(?:<[^()]*?>)?\(\s*'([a-z]+:[A-Za-z]+)'/g)) assert.ok(!typed.includes(m[1]!), `${file}: ${m[1]} is typed: call it with request()`)
  }
})
