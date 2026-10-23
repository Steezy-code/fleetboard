import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, FilePlus2, FolderCode, FolderPlus, Loader2, Pin, RefreshCw, Save, Search, X } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { errorText, fileUrl, invoke } from '../lib/api'
import { useApp } from '../state/store'
import { CodeEditor } from '../workbench/CodeEditor'
import { FileTree, ancestors, graft, type Creating, type TreeEntry } from '../workbench/FileTree'
import { FileIcon } from '../workbench/icons'
import { isImagePath, langFromPath, langLabel } from '../workbench/markdown'
import { baseName, dirname, joinPath, relativeTo, isInside } from '../workbench/paths'
import { MAX_TEXT_BYTES, type FileStat } from '../workbench/useFileText'
import type { WriteResult } from '@shared/types'
import { setUnsaved } from '../lib/unsaved'

interface Doc {
  path: string
  text: string | null
  saved: string
  error?: string
  binary?: boolean
  mtime: number
}

const toast = (t: string, tone?: 'info' | 'warn' | 'error' | 'ok') => useApp.getState().toast(t, tone)

/** Code studio: project file tree, highlighted editor with Save, Insert (pin the file on the board). */
export default function CodeStudio(props: { path?: string }) {
  const project = useApp((s) => s.project)
  const root = project?.path ?? ''
  const [tree, setTree] = useState<TreeEntry[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const docRef = useRef<Doc | null>(null)
  docRef.current = doc
  const dirty = !!doc && doc.text != null && doc.text !== doc.saved
  // so quitting asks before these edits go (lib/unsaved.ts)
  useEffect(() => {
    setUnsaved('code', dirty && doc ? baseName(doc.path) : null)
    return () => setUnsaved('code', null)
  }, [dirty, doc?.path])

  const loadTree = useCallback(async () => {
    if (!root) return
    const t = await invoke<TreeEntry[]>('fs:tree', root, 8).catch(() => [])
    setTree(t)
  }, [root])

  /** a folder the first read left out, read once it is opened */
  const loadDir = useCallback(async (dir: string) => {
    const children = await invoke<TreeEntry[]>('fs:tree', dir, 1).catch(() => null)
    if (children) setTree((t) => t && graft(t, dir, children))
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  /** the file asked for last: an earlier open whose read comes back later is dropped */
  const opening = useRef('')
  const open = useCallback(
    async (path: string, force = false) => {
      const cur = docRef.current
      if (!force && cur && cur.path === path) return
      if (!force && cur && cur.text != null && cur.text !== cur.saved) {
        const ok = await useApp.getState().confirm({ title: `Discard changes to ${baseName(cur.path)}?`, body: 'Your edits have not been saved.', confirm: 'Discard', danger: true })
        if (!ok) return
      }
      setLoadingFile(true)
      setExpanded((s) => new Set([...s, ...ancestors(root, path)]))
      opening.current = path
      const st = await invoke<FileStat | null>('fs:stat', path).catch(() => null)
      if (opening.current !== path) return
      if (!st || st.dir) {
        setDoc({ path, text: null, saved: '', error: st?.dir ? 'This is a folder' : 'File not found', mtime: 0 })
      } else if (isImagePath(path)) {
        setDoc({ path, text: null, saved: '', binary: true, mtime: st.mtime })
      } else if (st.size > MAX_TEXT_BYTES) {
        setDoc({ path, text: null, saved: '', error: `Too large to edit (${(st.size / 1024 / 1024).toFixed(1)} MB)`, mtime: st.mtime })
      } else {
        try {
          const text = await invoke<string>('fs:read', path)
          if (opening.current !== path) return
          if (text.slice(0, 8000).includes('\u0000')) setDoc({ path, text: null, saved: '', binary: true, mtime: st.mtime })
          else setDoc({ path, text, saved: text, mtime: st.mtime })
        } catch (e: any) {
          if (opening.current !== path) return
          setDoc({ path, text: null, saved: '', error: errorText(e), mtime: st.mtime })
        }
      }
      setLoadingFile(false)
    },
    [root]
  )

  // initial file: the one we were opened with, else README / package.json
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    if (props.path) {
      didInit.current = true
      open(props.path)
      return
    }
    if (!tree) return
    didInit.current = true
    if (docRef.current) return
    const top = tree.filter((e) => !e.dir)
    const pick = top.find((e) => /^readme\.md$/i.test(e.name)) ?? top.find((e) => e.name === 'package.json') ?? top[0]
    if (pick) open(pick.path)
  }, [props.path, tree]) // eslint-disable-line react-hooks/exhaustive-deps

  // reload when the file changes on disk and we have no unsaved edits
  useEffect(() => {
    if (!doc || doc.text == null) return
    const id = window.setInterval(async () => {
      const cur = docRef.current
      if (!cur || cur.text == null || cur.text !== cur.saved) return
      const st = await invoke<FileStat | null>('fs:stat', cur.path).catch(() => null)
      if (st && !st.dir && st.mtime !== cur.mtime && st.size <= MAX_TEXT_BYTES) {
        const text = await invoke<string>('fs:read', cur.path).catch(() => null)
        const now = docRef.current
        if (text != null && now && now.path === cur.path && now.text === now.saved) setDoc({ ...now, text, saved: text, mtime: st.mtime })
      }
    }, 3000)
    return () => window.clearInterval(id)
  }, [doc?.path, doc?.text == null]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save(): Promise<boolean> {
    const cur = docRef.current
    if (!cur || cur.text == null) return false
    if (cur.text === cur.saved) {
      flashSaved()
      return true
    }
    setSaving(true)
    try {
      // only over what we loaded: an agent may have changed the file since
      const r = await invoke<WriteResult>('fs:write', cur.path, cur.text, { base: cur.saved })
      if (!r.ok) {
        const disk = r.current
        const name = cur.path.split('/').pop()
        const app = useApp.getState()
        if (await app.confirm({ title: `${name} changed on disk`, body: `It was ${disk === null ? 'deleted' : 'changed'} since you opened it, maybe by an agent. Replace it with your version?`, confirm: 'Replace with mine', danger: true })) {
          await invoke<WriteResult>('fs:write', cur.path, cur.text)
        } else {
          if (disk !== null && (await app.confirm({ title: 'Load the version on disk?', body: 'Your unsaved edits to it are lost. Otherwise you keep editing yours.', confirm: 'Load the version on disk', danger: true }))) {
            const st = await invoke<FileStat | null>('fs:stat', cur.path)
            setDoc((d) => (d && d.path === cur.path ? { ...d, text: disk, saved: disk, mtime: st?.mtime ?? d.mtime } : d))
          }
          return false
        }
      }
      const st = await invoke<FileStat | null>('fs:stat', cur.path)
      setDoc((d) => (d && d.path === cur.path ? { ...d, saved: cur.text!, mtime: st?.mtime ?? d.mtime } : d))
      flashSaved()
      return true
    } catch (e: any) {
      toast(`Save failed: ${errorText(e)}`, 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const flashTimer = useRef<number>(undefined)
  function flashSaved() {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600)
  }

  async function insert() {
    if (!doc) return
    if (dirty && !(await save())) return
    const app = useApp.getState()
    const id = app.addNode({ type: 'file', title: baseName(doc.path), data: { path: doc.path } })
    app.closePanel()
    app.setSelection([id])
    toast(`Pinned ${baseName(doc.path)} to the board`, 'ok')
  }

  async function close() {
    if (dirty) {
      const ok = await useApp.getState().confirm({ title: `Close without saving ${baseName(doc!.path)}?`, confirm: 'Discard', danger: true })
      if (!ok) return
    }
    useApp.getState().closePanel()
  }

  function startCreate(kind: 'file' | 'folder') {
    setAddMenu(false)
    setQuery('')
    const dir = selectedDir ?? (doc ? dirname(doc.path) : root)
    const target = dir.startsWith(root) ? dir : root
    if (target !== root) setExpanded((s) => new Set([...s, target, ...ancestors(root, target + '/x')]))
    setCreating({ dir: target, kind })
  }

  async function create(name: string) {
    const c = creating
    setCreating(null)
    if (!c) return
    const path = joinPath(c.dir, name)
    if (!isInside(root, path) || !relativeTo(root, path)) return toast('Stay inside the project folder', 'warn')
    if (await invoke<boolean>('fs:exists', path)) return toast(`${name} already exists`, 'warn')
    try {
      if (c.kind === 'folder') {
        await invoke('fs:mkdir', path)
        setExpanded((s) => new Set([...s, path]))
        setSelectedDir(path)
      } else {
        // not an exists-check and then a write: between the two, an agent writing that same path
        // would have had its file truncated to nothing by this one
        const r = await invoke<WriteResult>('fs:write', path, '', { base: null })
        if (!r.ok) return toast(`${name} already exists`, 'warn')
      }
      await loadTree()
      if (c.kind === 'file') open(path, true)
    } catch (e: any) {
      toast(errorText(e), 'error')
    }
  }

  // Ctrl+S anywhere in the studio; Escape asks before dropping unsaved edits
  const keyRef = useRef({ save, close, dirty })
  keyRef.current = { save, close, dirty }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!(e.target as HTMLElement)?.classList?.contains('ce-ta')) keyRef.current.save()
      } else if (e.key === 'Escape' && keyRef.current.dirty && !useApp.getState().confirms.length && !(e.target instanceof HTMLInputElement)) {
        e.stopImmediatePropagation()
        e.preventDefault()
        keyRef.current.close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const rel = doc ? relativeTo(root, doc.path) : ''
  const crumbs = rel ? rel.split('/') : []
  const lang = doc ? langFromPath(doc.path) : 'plaintext'
  const lines = useMemo(() => (doc?.text != null ? doc.text.split('\n').length : 0), [doc?.text])
  const fileCount = useMemo(() => (tree ? countFiles(tree) : 0), [tree])

  return (
    <Modal title="Code" sub={project?.name} icon={<FolderCode size={17} />} width="min(1200px, 94vw)" height="86vh" bare onClose={close}>
      <div className="wbs">
        <aside className="wbs-side">
          <div className="wbs-side-head">
            <div className="wbs-search">
              <Search size={13} className="dim" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${fileCount} files`} />
              {query && (
                <button className="icon-btn sm" onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <button className="icon-btn sm" title="Refresh tree" onClick={loadTree}>
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="wbs-tree scrollable">
            {tree == null ? (
              <div className="ftree-none">
                <Loader2 size={14} className="spin" />
              </div>
            ) : (
              <FileTree
                entries={tree}
                root={root}
                active={doc?.path}
                query={query}
                expanded={expanded}
                onLoad={loadDir}
                onToggle={(d) =>
                  setExpanded((s) => {
                    const n = new Set(s)
                    if (n.has(d)) n.delete(d)
                    else n.add(d)
                    return n
                  })
                }
                onOpen={(p) => {
                  setSelectedDir(null)
                  open(p)
                }}
                selectedDir={selectedDir}
                onSelectDir={setSelectedDir}
                creating={creating}
                onCreate={create}
                onCancelCreate={() => setCreating(null)}
              />
            )}
          </div>
        </aside>

        <section className="wbs-main">
          <div className="wbs-bar">
            <div className="wb-crumbs grow" title={doc?.path}>
              {doc && <FileIcon name={baseName(doc.path)} size={13} />}
              {crumbs.length === 0 && <span className="dim">No file open</span>}
              {crumbs.map((c, i) => (
                <span key={i} className="row" style={{ gap: 4 }}>
                  {i > 0 && <ChevronRight size={11} className="dim" />}
                  <span className={i === crumbs.length - 1 ? 'wb-crumb-last' : 'wb-crumb'}>{c}</span>
                </span>
              ))}
              {dirty && <span className="wb-dirty-dot" title="Unsaved changes" />}
            </div>
            {doc?.text != null && (
              <>
                <span className="pill wb-lang-pill">{langLabel(lang)}</span>
                <span className="dim small">{lines.toLocaleString()} lines</span>
              </>
            )}
            <div className="wbs-add">
              <button className="btn sm" onClick={() => setAddMenu((v) => !v)} title="New file or folder">
                <FolderPlus size={13} /> Add folder
              </button>
              {addMenu && (
                <div className="menu wbs-add-menu" onMouseLeave={() => setAddMenu(false)}>
                  <button className="menu-item" onClick={() => startCreate('file')}>
                    <span className="ic">
                      <FilePlus2 size={14} />
                    </span>
                    New file
                  </button>
                  <button className="menu-item" onClick={() => startCreate('folder')}>
                    <span className="ic">
                      <FolderPlus size={14} />
                    </span>
                    New folder
                  </button>
                  <div className="menu-label dim small">in {relativeTo(root, selectedDir ?? (doc ? dirname(doc.path) : root)) || project?.name}</div>
                </div>
              )}
            </div>
            <button className={`btn sm ${savedFlash ? 'saved' : ''}`} onClick={save} disabled={!doc || doc.text == null || saving} title="Save (Ctrl+S)">
              {saving ? <Loader2 size={13} className="spin" /> : savedFlash ? <Check size={13} /> : <Save size={13} />}
              {savedFlash ? 'Saved' : 'Save'}
            </button>
            <button className="btn sm primary" onClick={insert} disabled={!doc || !!doc.error} title="Pin this file to the board">
              <Pin size={13} /> Insert
            </button>
          </div>
          <div className="wbs-editor">
            {loadingFile && !doc ? (
              <div className="empty">
                <Loader2 size={16} className="spin" />
              </div>
            ) : !doc ? (
              <div className="empty">
                <FolderCode size={28} className="dim" />
                <div>Pick a file from the tree</div>
              </div>
            ) : doc.error ? (
              <div className="empty">{doc.error}</div>
            ) : doc.binary ? (
              isImagePath(doc.path) ? (
                <div className="wbs-img">
                  <img src={fileUrl(doc.path)} alt={baseName(doc.path)} />
                </div>
              ) : (
                <div className="empty">
                  <div>Binary file</div>
                  <button className="btn sm" onClick={() => invoke('shell:openPath', doc.path)}>
                    Open with system app
                  </button>
                </div>
              )
            ) : (
              <CodeEditor key={doc.path} value={doc.text ?? ''} language={lang} onChange={(v) => setDoc((d) => (d ? { ...d, text: v } : d))} onSave={save} />
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function countFiles(list: TreeEntry[]): number {
  let n = 0
  for (const e of list) n += e.dir ? countFiles(e.children ?? []) : 1
  return n
}
