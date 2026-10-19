import fs from 'node:fs'
import path from 'node:path'
import { dialog, shell } from 'electron'
import type { MainContext } from './context'
import { dirs } from './paths'

export interface TreeEntry {
  name: string
  path: string
  dir: boolean
  children?: TreeEntry[]
}

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'out', 'build', '.turbo', '.cache', 'target', '.venv', 'venv', '__pycache__', '.DS_Store'])

function tree(dir: string, depth: number, filter?: (name: string) => boolean): TreeEntry[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => !IGNORE.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .flatMap((e): TreeEntry[] => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const children = depth > 0 ? tree(p, depth - 1, filter) : undefined
        if (filter && children && children.length === 0) return []
        return [{ name: e.name, path: p, dir: true, children }]
      }
      if (filter && !filter(e.name)) return []
      return [{ name: e.name, path: p, dir: false }]
    })
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  ipc.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipc.handle('dialog:openFile', async (_e, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openFile'], filters })
    return r.canceled ? null : r.filePaths[0]
  })
  ipc.handle('dialog:saveFile', async (_e, defaultPath: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(ctx.win()!, { defaultPath, filters })
    return r.canceled ? null : r.filePath
  })
  ipc.handle('fs:tree', (_e, dir: string, depth = 8, ext?: string[]) =>
    tree(dir, depth, ext ? (n) => ext.some((x) => n.toLowerCase().endsWith(x)) : undefined)
  )
  ipc.handle('fs:list', (_e, dir: string) => tree(dir, 0))
  ipc.handle('fs:read', (_e, file: string) => fs.readFileSync(file, 'utf8'))
  ipc.handle('fs:readBase64', (_e, file: string) => fs.readFileSync(file).toString('base64'))
  ipc.handle('fs:write', (_e, file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  })
  ipc.handle('fs:writeBase64', (_e, file: string, b64: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  })
  ipc.handle('fs:exists', (_e, p: string) => fs.existsSync(p))
  ipc.handle('fs:mkdir', (_e, p: string) => fs.mkdirSync(p, { recursive: true }))
  ipc.handle('fs:stat', (_e, p: string) => {
    try {
      const s = fs.statSync(p)
      return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }
    } catch {
      return null
    }
  })
  ipc.handle('fs:assetsDir', () => dirs.assets)
  ipc.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipc.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
  ipc.handle('shell:showItem', (_e, p: string) => shell.showItemInFolder(p))
}
