import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FilePlus2, FolderPlus } from 'lucide-react'
import type { TreeEntry } from '@shared/types'
import { FileIcon, FolderIcon } from './icons'
import { dirname, relativeTo, stripExt } from './paths'

export type { TreeEntry }

export interface Creating {
  dir: string
  kind: 'file' | 'folder'
}

interface Props {
  entries: TreeEntry[]
  root: string
  active?: string | null
  query?: string
  expanded: Set<string>
  onToggle: (dir: string) => void
  onOpen: (path: string) => void
  /** folder clicked (target for new files) */
  selectedDir?: string | null
  onSelectDir?: (dir: string) => void
  /** show "note" instead of "note.md" */
  hideExt?: boolean
  /** extra search hit test (e.g. note contents) */
  extraMatch?: (path: string) => boolean
  creating?: Creating | null
  onCreate?: (name: string) => void
  onCancelCreate?: () => void
  /** read a folder the tree has not read yet (too deep, or a big project), once it is opened */
  onLoad?: (dir: string) => Promise<void>
}

export function flattenFiles(entries: TreeEntry[], out: TreeEntry[] = []): TreeEntry[] {
  for (const e of entries) {
    if (e.dir) flattenFiles(e.children ?? [], out)
    else out.push(e)
  }
  return out
}

/** The tree with `dir`'s children read in. */
export function graft(entries: TreeEntry[], dir: string, children: TreeEntry[]): TreeEntry[] {
  return entries.map((e) => {
    if (!e.dir) return e
    if (e.path === dir) return { ...e, children }
    if (e.children && (dir.startsWith(e.path + '/') || dir.startsWith(e.path + '\\'))) return { ...e, children: graft(e.children, dir, children) }
    return e
  })
}

/** Expand every folder on the way to `path`. */
export function ancestors(root: string, path: string): string[] {
  const out: string[] = []
  let d = dirname(path)
  while (d.length > root.length && d.startsWith(root)) {
    out.push(d)
    d = dirname(d)
  }
  return out
}

export function FileTree(p: Props) {
  const q = (p.query ?? '').trim().toLowerCase()
  const activeRef = useRef<HTMLDivElement>(null)
  // open folders not read yet, found while rendering: read after it
  const unread: string[] = []
  const loading = useRef(new Set<string>())
  useEffect(() => {
    for (const d of unread) {
      if (!p.onLoad || loading.current.has(d)) continue
      loading.current.add(d)
      p.onLoad(d).finally(() => loading.current.delete(d))
    }
  })

  const hits = useMemo(() => {
    if (!q) return null
    return flattenFiles(p.entries)
      .filter((f) => f.name.toLowerCase().includes(q) || relativeTo(p.root, f.path).toLowerCase().includes(q) || p.extraMatch?.(f.path))
      .slice(0, 400)
  }, [q, p.entries, p.root, p.extraMatch])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [p.active])

  const label = (name: string) => (p.hideExt ? stripExt(name) : name)

  const createRow = (depth: number) =>
    p.creating && (
      <CreateRow key="__create" depth={depth} kind={p.creating.kind} onCreate={(n) => p.onCreate?.(n)} onCancel={() => p.onCancelCreate?.()} />
    )

  if (hits) {
    return (
      <div className="ftree">
        {hits.length === 0 && <div className="ftree-none">No matches</div>}
        {hits.map((f) => {
          const rel = relativeTo(p.root, dirname(f.path))
          return (
            <div key={f.path} ref={f.path === p.active ? activeRef : undefined} className={`ft-row ${f.path === p.active ? 'active' : ''}`} style={{ paddingLeft: 10 }} onClick={() => p.onOpen(f.path)} title={f.path}>
              <FileIcon name={f.name} size={13} />
              <span className="ft-name">{label(f.name)}</span>
              {rel && <span className="ft-dir">{rel}</span>}
            </div>
          )
        })}
      </div>
    )
  }

  const render = (list: TreeEntry[], depth: number, parent: string): React.ReactNode[] => {
    const rows: React.ReactNode[] = []
    if (p.creating && p.creating.dir === parent) rows.push(createRow(depth))
    for (const e of list) {
      if (e.dir) {
        const open = p.expanded.has(e.path)
        rows.push(
          <div
            key={e.path}
            className={`ft-row ft-dir-row ${p.selectedDir === e.path ? 'sel' : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => {
              p.onToggle(e.path)
              p.onSelectDir?.(e.path)
            }}
            title={e.path}
          >
            <ChevronRight size={12} className={`ft-chev ${open ? 'open' : ''}`} />
            <FolderIcon open={open} name={e.name} size={13} />
            <span className="ft-name">{e.name}</span>
          </div>
        )
        if (open) {
          if (e.children) rows.push(...render(e.children, depth + 1, e.path))
          else {
            unread.push(e.path)
            rows.push(<div key={e.path + '/…'} className="ftree-none" style={{ paddingLeft: 26 + depth * 14 }}>…</div>)
          }
        }
      } else {
        const active = e.path === p.active
        rows.push(
          <div key={e.path} ref={active ? activeRef : undefined} className={`ft-row ${active ? 'active' : ''}`} style={{ paddingLeft: 20 + depth * 14 }} onClick={() => p.onOpen(e.path)} title={e.path}>
            <FileIcon name={e.name} size={13} />
            <span className="ft-name">{label(e.name)}</span>
          </div>
        )
      }
    }
    return rows
  }

  return <div className="ftree">{render(p.entries, 0, p.root)}</div>
}

function CreateRow({ depth, kind, onCreate, onCancel }: { depth: number; kind: 'file' | 'folder'; onCreate: (n: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const done = useRef(false)
  const finish = (ok: boolean) => {
    if (done.current) return
    done.current = true
    if (ok && name.trim()) onCreate(name.trim())
    else onCancel()
  }
  return (
    <div className="ft-row ft-create" style={{ paddingLeft: 20 + depth * 14 }}>
      {kind === 'folder' ? <FolderPlus size={13} className="dim" /> : <FilePlus2 size={13} className="dim" />}
      <input
        autoFocus
        className="ft-input"
        value={name}
        placeholder={kind === 'folder' ? 'folder name' : 'file name'}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) finish(true)
          if (e.key === 'Escape') {
            e.stopPropagation()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}
