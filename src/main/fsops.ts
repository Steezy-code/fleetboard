import fs from 'node:fs'
import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { dialog, shell } from 'electron'
import type { MainContext } from './context'
import { readRegularFile, readRegularText, writeDurable } from './paths'
import type { WriteResult } from '@shared/types'
import { toRendererPath } from './platform'
import { allowed, grant, grantDropped, outsideMessage } from './roots'

/** The most a text read hands the renderer: any source file, note or log; past this it is not a text to edit here. */
const MAX_READ = 32 * 1024 * 1024

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
        const entries = (lists[j] ?? []).filter((e) => !IGNORE.has(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
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
 * is there now (null: the file is gone). `base: null` means "only if it is not there" — which is what
 * creating a file is, and is why creating one is not an exists-check followed by a write. Written
 * through writeDurable, so neither a crash nor a power loss can leave it half written or empty; its
 * permissions are kept.
 */
export function writeText(file: string, content: string, base?: string | null): WriteResult {
  let existing: Buffer | null = null
  try {
    existing = readRegularFile(file, MAX_READ)
  } catch {
    /* gone, or not a file this could have written */
  }
  // A textarea gives back "\n" for every line break, so a file that uses CRLF keeps its own line
  // endings when saved; and the editor's idea of what is on disk after that save is the LF text it
  // sent, which is the same file.
  const crlf = !!existing && usesCrlf(existing)
  const asOnDisk = (t: string) => (crlf ? t.replace(/\r?\n/g, '\r\n') : t)
  if (base !== undefined) {
    const current = existing ? existing.toString('utf8') : null
    if (current !== (base === null ? null : asOnDisk(base)) && current !== base) return { ok: false, reason: 'changed', current }
  }
  // An editor holds text, so a file that is not UTF-8 came to it with its odd bytes already replaced;
  // saving that would replace them on disk too.
  if (existing && !isUtf8(existing)) throw new Error(`${path.basename(file)} is not UTF-8 text, so it was not saved: writing it from an editor would change bytes the editor cannot show.`)
  writeResolved(file, asOnDisk(content))
  return { ok: true }
}

/** Every line break in it is CRLF (and there is at least one). */
function usesCrlf(b: Buffer): boolean {
  const t = b.toString('latin1')
  const lf = t.split('\n').length - 1
  return lf > 0 && t.split('\r\n').length - 1 === lf
}

/**
 * Write a file the user owns: through the symlink if it is one (a dotfile linked out to ~/dotfiles is
 * written where it points, not replaced by a plain file), keeping its permissions, atomically and
 * durably.
 */
function writeResolved(file: string, content: string | Uint8Array) {
  let target = file
  try {
    target = fs.realpathSync(file)
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const mode = fs.statSync(target, { throwIfNoEntry: false })?.mode
  // hidden, and beside the target: this one lands in the user's own project folder
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.fleetboard-${process.pid}-${Date.now()}.tmp`)
  writeDurable(target, content, mode === undefined ? undefined : mode & 0o7777, tmp)
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  // A file dropped on the board. Sent by the preload at the moment getPathForFile resolves it, which
  // only happens for a File backed by a real file, and the bridge's own send refuses this channel.
  // Without it every image or file dragged in from outside the project would be refused.
  ipc.on('fs:grantDropped', (_e, p: string) => grantDropped(String(p)))

  // a path the user picks is a path the user may use: the three dialogs are the only place that
  // intent is expressed, so they are the only place the allowed set grows (see roots.ts)
  ipc.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    grant(r.filePaths[0])
    return toRendererPath(r.filePaths[0])
  })
  ipc.handle('dialog:openFile', async (_e, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openFile'], filters })
    if (r.canceled || !r.filePaths[0]) return null
    grant(r.filePaths[0])
    return toRendererPath(r.filePaths[0])
  })
  ipc.handle('dialog:saveFile', async (_e, defaultPath: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(ctx.win()!, { defaultPath, filters })
    if (r.canceled || !r.filePath) return null
    grant(r.filePath)
    return toRendererPath(r.filePath)
  })
  // Reads keep the shape they already had for a path that is not there — an empty tree, null, false —
  // because callers rely on it (a file node on a missing path, an unreadable folder). Writes and opens
  // say so, because silently not writing is worse than an error.
  ipc.handle('fs:tree', (_e, dir: string, depth = 8, ext?: string[]) =>
    allowed(dir, 'fs:tree') ? tree(dir, depth, ext ? (n) => ext.some((x) => n.toLowerCase().endsWith(x)) : undefined) : []
  )
  ipc.handle('fs:read', (_e, file: string) => {
    // already throws for a missing file, so callers handle a throw
    if (!allowed(file, 'fs:read')) throw new Error(outsideMessage(file))
    return readRegularText(file, MAX_READ)
  })
  ipc.handle('fs:write', (_e, file: string, content: string, opts?: { base?: string | null }) => {
    if (!allowed(file, 'fs:write')) throw new Error(outsideMessage(file))
    return writeText(file, content, opts?.base)
  })
  ipc.handle('fs:writeBase64', (_e, file: string, b64: string) => {
    if (!allowed(file, 'fs:writeBase64')) throw new Error(outsideMessage(file))
    // the same write as fs:write: it used to truncate the target in place, so a write that ran out of
    // room destroyed whatever was there, and it replaced a symlink with a plain file
    writeResolved(file, Buffer.from(b64, 'base64'))
  })
  ipc.handle('fs:exists', (_e, p: string) => allowed(p, 'fs:exists') && fs.existsSync(p))
  ipc.handle('fs:mkdir', (_e, p: string) => {
    if (!allowed(p, 'fs:mkdir')) throw new Error(outsideMessage(p))
    return fs.mkdirSync(p, { recursive: true })
  })
  ipc.handle('fs:stat', (_e, p: string) => {
    if (!allowed(p, 'fs:stat')) return null
    try {
      const s = fs.statSync(p)
      return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }
    } catch {
      return null
    }
  })
  // openPath resolves with '' on success or an error string, so a refusal is just that string
  ipc.handle('shell:openPath', (_e, p: string) =>
    !allowed(p, 'shell:openPath') ? outsideMessage(p) : opensSafely(p) ? shell.openPath(p) : (shell.showItemInFolder(p), '')
  )
  ipc.handle('shell:openExternal', (_e, url: string) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url)
  })
  ipc.handle('shell:showItem', (_e, p: string) => {
    if (allowed(p, 'shell:showItem')) shell.showItemInFolder(p)
  })
}

/**
 * Files the desktop would run rather than show (scripts, binaries, launchers): a link in a README
 * must not start a program. Those are revealed in the file manager instead.
 */
/** Folders macOS opens by running them, or by installing what is inside. */
const BUNDLE = /\.(app|prefpane|workflow|action|saver|qlgenerator|mdimporter|plugin|bundle|kext|pkg|mpkg)\/?$/i

const RUNNABLE = /\.(desktop|sh|bash|zsh|fish|command|run|bin|appimage|exe|bat|cmd|com|msi|msp|ps1|psm1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|wsc|jar|deb|rpm|py|pl|rb|scpt|app|lnk|url|pif|x86_64|hta|scr|cpl|chm|msc|reg|xll|appx|msix|application|appref-ms|settingcontent-ms)$/i

/**
 * On Windows a file's type is all there is to go on, and the shell runs more of them than any list
 * keeps up with (.js and .jse under Windows Script Host, .pif, .chm, .settingcontent-ms, whatever is
 * registered next). So there it is the other way round: only types that open in a viewer are opened.
 * No SVG or HTML: those open in a browser, where they can run script.
 */
const VIEWABLE_ON_WINDOWS = /\.(md|markdown|txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|pdf|png|jpe?g|gif|webp|bmp|ico|tiff?|avif|mp3|wav|ogg|flac|m4a|mp4|webm|mov|mkv|avi|zip|docx|xlsx|pptx|odt|ods|odp|rtf|epub)$/i

export function opensSafely(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const st = fs.statSync(p)
    // a folder opens in the file manager, unless it is one macOS runs: an app bundle and its kin,
    // by its own name or the name a link to it hides (statSync follows the link, and so does open)
    if (st.isDirectory()) {
      const real = fs.realpathSync(p)
      return ![p, real].some((x) => RUNNABLE.test(x) || BUNDLE.test(x))
    }
    if (!st.isFile()) return false
    if (platform === 'win32') return VIEWABLE_ON_WINDOWS.test(p)
    if (st.mode & 0o111) return false
  } catch {
    return false
  }
  return !RUNNABLE.test(p)
}
