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
