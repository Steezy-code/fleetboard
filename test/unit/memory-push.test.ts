// Which consoles the memory push lists, and under which names. The list used to be packed into one
// "id|name|agentId|live|ws" string per console and split back apart positionally, so a console or
// workspace named with a | handed its fields to the wrong columns: the agent came out as a fragment
// of the name, and live came out false, which is what decides the preselection.
import '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pushTargets } = await import('@/continuity/memory')

const node = (id: string, name: string, agentId: string) => ({
  id,
  type: 'console' as const,
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  data: { agentId, name, cwd: '/p' }
})

const project = (nodes: ReturnType<typeof node>[]) =>
  ({
    schema: 1,
    id: 'p1',
    name: 'p',
    path: '/p',
    activeWorkspaceId: 'ws1',
    lastOpened: 1,
    extras: {},
    workspaces: [{ id: 'ws1', name: 'Front | back', nodes, groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }]
  }) as never

test('a console named with the old delimiter keeps every one of its fields', () => {
  const [t] = pushTargets(project([node('c1', 'build | web', 'claude')]), { c1: true })
  assert.deepEqual(t, { id: 'c1', name: 'build | web', agentId: 'claude', live: true, ws: 'Front | back' })
})

test('live comes from the live map, not from a field position', () => {
  const targets = pushTargets(project([node('c1', 'a|b', 'claude'), node('c2', 'plain', 'codex')]), { c2: true })
  assert.deepEqual(
    targets.map((t) => [t.id, t.live]),
    [
      ['c1', false],
      ['c2', true]
    ]
  )
})

test('only consoles are listed, and in workspace order', () => {
  const p = project([node('c1', 'one', 'claude'), { ...node('n2', 'a note', 'claude'), type: 'note' as 'console' }, node('c3', 'two', 'codex')])
  assert.deepEqual(
    pushTargets(p, {}).map((t) => t.id),
    ['c1', 'c3']
  )
})
