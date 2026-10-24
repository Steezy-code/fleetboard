import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portableBoard } from '../../src/shared/recovery'
import type { Project } from '../../src/shared/types'
const board = (): Project => ({ schema: 1, id: 'old', name: 'Old', path: '/old', lastOpened: 1, activeWorkspaceId: 'w', extras: { loops: [{ enabled: true }] }, workspaces: [{ id: 'w', name: 'Work', camera: { x: 0, y: 0, zoom: 1 }, extras: { automatic: true }, groups: [], wires: [], ink: [], nodes: [{ id: 'n', type: 'console', x: 0, y: 0, w: 100, h: 100, z: 1, data: { agentId: 'shell', launch: 'fresh', command: 'danger', extraArgs: ['--danger'], autoApprove: true, profileId: 'private' } }] }] })
test('imports bind to the open repo and clear unattended work and account selections', () => {
  const target = { ...board(), id: 'target', path: '/target', name: 'Target' }
  const p = portableBoard(board(), target)
  assert.equal(p.id, target.id); assert.equal(p.path, target.path)
  assert.deepEqual(p.extras, {}); assert.deepEqual(p.workspaces[0].extras, {})
  assert.deepEqual(p.workspaces[0].nodes[0]?.data, { agentId: 'shell', cwd: '/target', launch: 'ask', autoApprove: false, acceptEdits: false })
})
test('malformed, future and duplicate-ID boards are refused', () => {
  const p = board()
  for (const bad of [null, {}, { ...p, schema: 2 }, { ...p, workspaces: [] }, { ...p, workspaces: [{ ...p.workspaces[0], camera: null }] }]) assert.throws(() => portableBoard(bad, p))
  p.workspaces[0].nodes.push({ ...p.workspaces[0].nodes[0]! })
  assert.throws(() => portableBoard(p, p), /duplicate/)
})
test('zero-height ink lines remain importable', () => {
  const p = board()
  p.workspaces[0].ink.push({ id: 'line', kind: 'line', x: 0, y: 0, w: 100, h: 0, points: [[0, 0], [100, 0]], stroke: '#fff', fill: 'none', width: 1, opacity: 1 })
  assert.equal(portableBoard(p, p).workspaces[0].ink[0]?.h, 0)
})
test('import keeps saved documents and memory without mutating the source board', () => {
  const p = board()
  p.extras.documents = [{ id: 'doc', title: 'Design', markdown: '# Design' }]
  p.extras.memory = [{ id: 'memory', title: 'Convention', body: 'Use tests', repoPath: '/old' }]
  const target = { ...board(), path: '/target' }
  const result = portableBoard(p, target)
  assert.equal(result.extras.documents[0].markdown, '# Design')
  assert.equal(result.extras.memory[0].repoPath, '/target')
  assert.equal(p.workspaces[0].nodes[0]?.data.command, 'danger')
  assert.equal(p.extras.loops[0].enabled, true)
})
