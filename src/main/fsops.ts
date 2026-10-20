import fs from 'node:fs'
import path from 'node:path'
import { dialog, shell } from 'electron'
import type { MainContext } from './context'
import { dirs, renameRetrying } from './paths'
import type { WriteResult } from '@shared/types'
import { toRendererPath } from './platform'

export interface TreeEntry {
  name: string
  path: string
  dir: boolean
  children?: TreeEntry[]
}

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'out', 'build', '.turbo', '.cache', 'target', '.venv', 'venv', '__pycache__', '.DS_Store'])

/**
 * Entries a tree read visits at most: past that, folders are left unread (the tree loads them when
 * opened). A filtered tree (notes) returns few of them, so it may visit more.
 */
export const TREE_BUDGET = 30_000

/**
 * The folder's tree, `depth` levels of folders deep (deeper ones and those past the budget have no
 * `children`: not read yet). Read level by level, without blocking: a monorepo is many folders, and
 * the main process also carries every terminal's output.
 */
export async function tree(root: string, depth: number, filter?: (name: string) => boolean, budget = filter ? 5 * TREE_BUDGET : TREE_BUDGET): Promise<TreeEntry[]> {
  interface Pending {
    dir: string
    depth: number
    into: TreeEntry[]
    node?: TreeEntry
  }
  const top: TreeEntry[] = []
  let level: Pending[] = [{ dir: root, depth, into: top }]
  let left = budget
  while (level.length) {
    const next: Pending[] = []
    let i = 0
    // a few folders at a time
    for (; i < level.length && left > 0; i += 16) {
      const batch = level.slice(i, i + 16)
      const lists = await Promise.all(batch.map((p) => fs.promises.readdir(p.dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])))
      batch.forEach((p, j) => {
        const entries = lists[j].filter((e) => !IGNORE.has(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        left -= entries.length
        for (const e of entries) {
          const full = toRendererPath(path.join(p.dir, e.name))
          if (e.isDirectory()) {
            const node: TreeEntry = { name: e.name, path: full, dir: true }
            if (p.depth > 0) {
              node.children = []
              next.push({ dir: full, depth: p.depth - 1, into: node.children, node })
            }
            p.into.push(node)
          } else if (!filter || filter(e.name)) p.into.push({ name: e.name, path: full, dir: false })
        }
      })
    }
    // out of budget: what was not read stays unread
    for (const p of level.slice(i)) if (p.node) delete p.node.children
    if (left <= 0) {
      for (const p of next) if (p.node) delete p.node.children
      break
    }
    level = next
  }
  // with a filter, folders that hold nothing that passes it are left out (unread ones stay)
  const prune = (list: TreeEntry[]): TreeEntry[] =>
    list.filter((e) => {
      if (!e.dir || !e.children) return true
      e.children = prune(e.children)
      return e.children.length > 0
    })
  return filter ? prune(top) : top
}

/**
 * Write a file the user edits. With `base` (what the editor loaded or last saved), only while the file
 * still holds exactly that: an agent's change made meanwhile is never overwritten; the caller gets what
 * is there now (null: the file is gone). Written to a temporary file and renamed, so a crash midway
 * never leaves it half written; its permissions are kept.
 */
export function writeText(file: string, content: string, base?: string): WriteResult {
  if (base !== undefined) {
    let current: string | null = null
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch {
      /* gone */
    }
    if (current !== base) return { ok: false, reason: 'changed', current }
  }
  // a symlinked file (dotfiles) is written where it points, not replaced by a plain file
  let target = file
  try {
    target = fs.realpathSync(file)
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const mode = fs.statSync(target, { throwIfNoEntry: false })?.mode
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.fleetboard-${process.pid}-${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode: mode & 0o7777 } : undefined)
    renameRetrying(tmp, target)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return { ok: true }
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  ipc.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : toRendererPath(r.filePaths[0])
  })
  ipc.handle('dialog:openFile', async (_e, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openFile'], filters })
    return r.canceled ? null : toRendererPath(r.filePaths[0])
  })
  ipc.handle('dialog:saveFile', async (_e, defaultPath: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(ctx.win()!, { defaultPath, filters })
    return r.canceled ? null : toRendererPath(r.filePath)
  })
  ipc.handle('fs:tree', (_e, dir: string, depth = 8, ext?: string[]) => tree(dir, depth, ext ? (n) => ext.some((x) => n.toLowerCase().endsWith(x)) : undefined))
  ipc.handle('fs:list', (_e, dir: string) => tree(dir, 0))
  ipc.handle('fs:read', (_e, file: string) => fs.readFileSync(file, 'utf8'))
  ipc.handle('fs:readBase64', (_e, file: string) => fs.readFileSync(file).toString('base64'))
  ipc.handle('fs:write', (_e, file: string, content: string, opts?: { base?: string }) => writeText(file, content, opts?.base))
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
  ipc.handle('shell:openPath', (_e, p: string) => (opensSafely(p) ? shell.openPath(p) : (shell.showItemInFolder(p), '')))
  ipc.handle('shell:openExternal', (_e, url: string) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url)
  })
  ipc.handle('shell:showItem', (_e, p: string) => shell.showItemInFolder(p))
}

/**
 * Files the desktop would run rather than show (scripts, binaries, launchers): a link in a README
 * must not start a program. Those are revealed in the file manager instead.
 */
const RUNNABLE = /\.(desktop|sh|bash|zsh|fish|command|run|bin|appimage|exe|bat|cmd|com|msi|ps1|vbs|jar|deb|rpm|py|pl|rb|scpt|app|lnk|url|x86_64|hta|scr|cpl|wsf|wsh|msc|reg|psm1|appx|msix)$/i
export function opensSafely(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (st.isDirectory()) return true
    if (!st.isFile()) return false
    if (st.mode & 0o111) return false
  } catch {
    return false
  }
  return !RUNNABLE.test(p)
}
