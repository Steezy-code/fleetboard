// The Orchestrator types a command into the consoles it @mentions, against the real store.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { useApp } = await import('@/state/store')
const { dispatchCommand, parseMentions } = await import('@/engine/orchestrator')

function seed() {
  const con = (id: string, name: string, agentId = 'claude', groupId?: string) => ({ id, type: 'console', x: 0, y: 0, w: 100, h: 100, z: 1, groupId, data: { name, agentId } })
  useApp.setState({
    project: {
      schema: 1,
      id: 'p',
      name: 'p',
      path: '/tmp/p',
      activeWorkspaceId: 'w',
      lastOpened: 0,
      extras: {},
      workspaces: [
        {
          id: 'w',
          name: 'W',
          nodes: [
            con('maya', 'Maya'),
            con('leo', 'Leo', 'codex', 'g1'),
            con('ivy', 'Ivy', 'claude', 'g1'),
            { id: 'note1', type: 'note', x: 0, y: 0, w: 10, h: 10, z: 1, groupId: 'g1', data: { text: 'a note in the team' } },
            con('maya2', 'Maya 2')
          ],
          groups: [{ id: 'g1', name: 'Backend', role: 'backend', x: 0, y: 0, w: 10, h: 10 }],
          wires: [],
          ink: [],
          camera: { x: 0, y: 0, zoom: 1 },
          extras: {}
        }
      ]
    } as any,
    live: { maya: true, leo: true, ivy: true, maya2: true },
    statuses: { maya: 'idle', leo: 'idle', ivy: 'idle', maya2: 'idle' }
  })
}
const pastes = () => ipc.sent.filter((s) => s.channel === 'pty:paste').map((s) => [s.args[0], s.args[1]])

beforeEach(() => {
  ipc.sent.length = 0
  seed()
})

test('@names pick the consoles and are taken out of the text', () => {
  const r = dispatchCommand('@Maya run the tests')
  assert.deepEqual(pastes(), [['maya', 'run the tests']])
  assert.deepEqual(r.unresolved, [])
  dispatchCommand('@Maya2, @Leo: pull first')
  assert.deepEqual(pastes().slice(1), [['maya2', 'pull first'], ['leo', 'pull first']])
})

test('an @word that names no console stays in the text: scoped packages, decorators, handles', () => {
  dispatchCommand('@Maya install @types/node and use @Injectable on the service, then ping @octocat')
  assert.deepEqual(pastes(), [['maya', 'install @types/node and use @Injectable on the service, then ping @octocat']])
})

test('nothing is sent when every @mention is unknown (a typo must not go to everyone)', () => {
  const r = dispatchCommand('@Mya run the tests')
  assert.deepEqual(pastes(), [])
  assert.deepEqual(r.unresolved, ['Mya'])
})

test('a text with no @mention goes to the default targets, @words in it untouched', () => {
  dispatchCommand('add @types/node', ['maya', 'leo'])
  assert.deepEqual(pastes(), [['maya', 'add @types/node'], ['leo', 'add @types/node']])
})

test('a team mention reaches its consoles only, not the other tiles in the group', () => {
  const r = dispatchCommand('@backend migrate the db')
  assert.deepEqual(pastes().map((p) => p[0]).sort(), ['ivy', 'leo'])
  assert.deepEqual(r.skipped, [])
})

test('parseMentions: e-mail addresses and paths are not mentions', () => {
  const isName = (w: string) => w === 'Maya'
  assert.deepEqual(parseMentions('@Maya: mail bob@example.com about it.', isName), { mentions: ['Maya'], unknown: [], body: 'mail bob@example.com about it.' })
  assert.deepEqual(parseMentions('ask @Maya.', isName), { mentions: ['Maya'], unknown: [], body: 'ask' })
  assert.deepEqual(parseMentions('bump @angular/core', isName), { mentions: [], unknown: [], body: 'bump @angular/core' })
})
