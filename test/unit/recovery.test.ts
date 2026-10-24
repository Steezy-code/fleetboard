import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, dialog } from '../support/electron-stub'
import type { Project } from '../../src/shared/types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-recovery-'))
process.env.FLEETBOARD_HOME = path.join(root, 'state')
const { saveProject, currentProject } = await import('../../src/main/store')
const { register } = await import('../../src/main/recovery')
const { dirs } = await import('../../src/main/paths')
const p: Project = { schema: 1, id: 'project', name: 'Repo', path: root, activeWorkspaceId: 'w', lastOpened: 1, extras: {}, workspaces: [{ id: 'w', name: 'Work', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] }
const ptys = { size: 0 }
saveProject(p)
register({ ipc: ipcMain, ptys } as any)

test('native import/export round trip previews, refuses live consoles and backs up before apply', async () => {
  const file = path.join(root, 'board.json')
  ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: file })
  assert.equal(await ipcMain.invoke('recovery:export'), file)
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(exported.workspaces.length, 1)
  exported.workspaces[0].name = 'Imported workspace'
  fs.writeFileSync(file, JSON.stringify(exported))
  ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  const preview = await ipcMain.invoke('recovery:import')
  assert.equal(preview.contents[0].name, 'Imported workspace')
  assert.equal(currentProject()?.workspaces[0].name, 'Work', 'preview never changes the active board')
  ptys.size = 1
  await assert.rejects(ipcMain.invoke('recovery:apply', preview.token), /Close running/)
  ptys.size = 0
  await ipcMain.invoke('recovery:apply', preview.token)
  assert.equal(currentProject()?.workspaces[0].name, 'Imported workspace')
  const backups = fs.readdirSync(dirs.history).filter((f) => f.startsWith('project-')).map((f) => JSON.parse(fs.readFileSync(path.join(dirs.history, f), 'utf8')))
  assert.ok(backups.some((p) => p.workspaces[0].name === 'Work'))
  await assert.rejects(ipcMain.invoke('recovery:apply', preview.token), /expired/)
  await assert.rejects(ipcMain.invoke('recovery:preview', '../app.json'), /not found/)
})
