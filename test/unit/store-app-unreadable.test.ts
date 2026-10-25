// app.json is read once, at import: one that is there but cannot be read must not be replaced by defaults
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'

const canLockOut = process.platform !== 'win32' && process.getuid?.() !== 0

test('an unreadable app.json: defaults for this session, the file left exactly as it was', { skip: !canLockOut }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-store-app-'))
  const appFile = path.join(home, 'app.json')
  const saved = JSON.stringify({ schema: 1, settings: { names: ['Ada'] }, projects: [{ id: 'p1', name: 'one', path: home, lastOpened: 1, consoles: 0 }], global: { fsGrants: ['/somewhere'] } })
  fs.writeFileSync(appFile, saved)
  fs.chmodSync(appFile, 0o000)
  process.env.FLEETBOARD_HOME = home
  const store = await import('../../src/main/store')
  store.register({ ipc: ipcMain as any, win: () => null, ptys: null as any, settings: store.getSettings, emit: () => {} } as any)
  try {
    assert.deepEqual(await ipcMain.invoke('store:recoveries'), [{ what: 'app', corruptCopy: '', unreadable: true }], 'the user is told: unreadable, not damaged, and nothing was moved')
    // every path that writes app.json
    await ipcMain.invoke('store:setSettings', { autoApprove: true })
    await ipcMain.invoke('store:setGlobal', 'k', 1)
    store.saveProject({ schema: 1, id: 'p2', name: 'two', path: home, activeWorkspaceId: 'w', lastOpened: 2, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] } as any)
  } finally {
    fs.chmodSync(appFile, 0o600)
  }
  assert.equal(fs.readFileSync(appFile, 'utf8'), saved, 'not rewritten without its projects, settings and fsGrants')
  fs.rmSync(home, { recursive: true, force: true })
})
