import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dialog } from 'electron'
import type { MainContext } from './context'
import { dirs, readRegularText, writeJsonAtomic } from './paths'
import { fleetState } from './fleet'
import { currentProject, saveProject } from './store'
import { portableBoard, type BoardPreview, type SnapshotInfo } from '@shared/recovery'
import type { Project } from '@shared/types'

const MAX_BYTES = 20 * 1024 * 1024
let pending: { token: string; projectId: string; board: Project } | undefined
const current = () => {
  const p = currentProject()
  if (!p) throw new Error('Open a board first')
  return p
}
export function snapshotList(projectId: string): SnapshotInfo[] {
  if (!/^[\w-]+$/.test(projectId)) throw new Error('Invalid project ID')
  return fs.readdirSync(dirs.history).flatMap((id) => {
    const match = new RegExp(`^${projectId}-([0-9]+)\\.json$`).exec(id)
    if (!match) return []
    const stat = fs.lstatSync(path.join(dirs.history, id))
    return stat.isFile() && stat.size <= MAX_BYTES ? [{ id, at: Number(match[1]), bytes: stat.size }] : []
  }).sort((a, b) => b.at - a.at)
}
function preview(file: string): BoardPreview {
  const target = current()
  const raw: unknown = JSON.parse(readRegularText(file, MAX_BYTES))
  const board = portableBoard(raw, target)
  const token = crypto.randomUUID()
  pending = { token, projectId: target.id, board }
  return {
    token,
    name: board.name,
    workspaces: board.workspaces.length,
    tiles: board.workspaces.reduce((n, w) => n + w.nodes.length, 0),
    consoles: board.workspaces.reduce((n, w) => n + w.nodes.filter((x) => x.type === 'console').length, 0),
    contents: board.workspaces.map((w) => ({
      name: w.name,
      tiles: w.nodes.length,
      titles: w.nodes.slice(0, 6).map((n) => String(n.title || n.data?.text || n.data?.name || n.type).slice(0, 100))
    })),
    notes: [
      'Replaces the board layout and content; repository files are unchanged.',
      'Consoles wait for you to start them. Scheduled work, account selections and automatic approvals are cleared. Saved documents and project memory are kept.',
      'Images and files remain path references; copy those files separately when moving computers.'
    ]
  }
}
export function register(ctx: MainContext) {
  ctx.ipc.handle('recovery:list', () => snapshotList(current().id))
  ctx.ipc.handle('recovery:preview', (_e, id: string) => {
    if (!snapshotList(current().id).some((s) => s.id === id)) throw new Error('Snapshot not found')
    return preview(path.join(dirs.history, id))
  })
  ctx.ipc.handle('recovery:import', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import a Fleetboard board', properties: ['openFile'], filters: [{ name: 'Fleetboard JSON', extensions: ['json'] }] })
    return result.canceled || !result.filePaths[0] ? null : preview(result.filePaths[0])
  })
  ctx.ipc.handle('recovery:export', async () => {
    const p = current()
    const result = await dialog.showSaveDialog({ title: 'Export board', defaultPath: `${p.name}.fleetboard.json`, filters: [{ name: 'Fleetboard JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return null
    // Never export account profiles or app-wide secrets; autonomy is cleared on import too.
    writeJsonAtomic(result.filePath, portableBoard(structuredClone(p), p))
    return result.filePath
  })
  ctx.ipc.handle('recovery:apply', (_e, token: string) => {
    const p = current()
    if (!pending || pending.token !== token || pending.projectId !== p.id) throw new Error('Preview expired; select the board again')
    if (ctx.ptys.size) throw new Error('Close running consoles before replacing the board')
    if (Object.values(fleetState(p.id)?.members ?? {}).some((m) => m.status !== 'closed')) throw new Error('Finish or discard the current team before replacing the board')
    const board = pending.board
    // A dedicated snapshot, even inside the normal five-minute snapshot interval.
    writeJsonAtomic(path.join(dirs.history, `${p.id}-${Date.now()}.json`), p)
    saveProject(board)
    pending = undefined
    return board
  })
}
