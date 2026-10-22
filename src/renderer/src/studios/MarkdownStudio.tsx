import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpenText, Check, ChevronRight, FileDown, LayoutDashboard, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Modal, Seg } from '../ui/Modal'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { FileTree, ancestors, graft, flattenFiles, type Creating, type TreeEntry } from '../workbench/FileTree'
import { LinkGraph, type GraphNode } from '../workbench/LinkGraph'
import { extractLinks, firstHeading, handleMdClick, isMarkdownPath, renderMarkdown } from '../workbench/markdown'
import { exportMarkdownPdf } from '../workbench/pdf'
import { baseName, dirname, joinPath, relativeTo, stripExt, isInside } from '../workbench/paths'
import type { FileStat } from '../workbench/useFileText'
import type { WriteResult } from '@shared/types'

type Mode = 'reading' | 'source' | 'graph'
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

const MD_EXT = ['.md', '.mdx']
const MAX_NOTES = 800
const toast = (t: string, tone?: 'info' | 'warn' | 'error' | 'ok') => useApp.getState().toast(t, tone)

interface VaultIndex {
  set: Set<string>
  byRel: Map<string, string>
  byName: Map<string, string[]>
}

function buildIndex(paths: string[], root: string): VaultIndex {
  const byRel = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const p of paths) {
    byRel.set(stripExt(relativeTo(root, p)).toLowerCase(), p)
    const n = stripExt(baseName(p)).toLowerCase()
    byName.set(n, [...(byName.get(n) ?? []), p])
  }
  return { set: new Set(paths), byRel, byName }
}

function resolveWiki(ix: VaultIndex, target: string, from: string | null): string | null {
  const t = target.replace(/#.*$/, '').trim().replace(/\.(md|mdx)$/i, '').toLowerCase()
  if (!t) return null
  if (ix.byRel.has(t)) return ix.byRel.get(t)!
  if (t.includes('/')) {
    for (const [rel, p] of ix.byRel) if (rel.endsWith('/' + t)) return p
  }
  const hits = ix.byName.get(baseName(t))
  if (!hits?.length) return null
  if (from) {
    const d = dirname(from)
    const same = hits.find((h) => dirname(h) === d)
    if (same) return same
  }
  return hits[0] ?? null
}

function resolveFile(ix: VaultIndex, href: string, from: string, root: string): string | null {
  const abs = href.startsWith('/') ? (ix.set.has(href) ? href : joinPath(root, href)) : joinPath(dirname(from), href)
  return ix.set.has(abs) ? abs : null
}

/** Obsidian-style vault over the project's markdown: tree, Reading / Source / Graph, autosave, PDF, Add to Board. */
export default function MarkdownStudio(props: { path?: string }) {
  const project = useApp((s) => s.project)
  const root = project?.path ?? ''
  const [tree, setTree] = useState<TreeEntry[] | null>(null)
  const [notes, setNotes] = useState<Map<string, string>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('fb.md.mode') as Mode) || 'reading')
  const [save, setSave] = useState<SaveState>('saved')
  const [creating, setCreating] = useState<Creating | null>(null)
  const [exporting, setExporting] = useState(false)

  const saveTimer = useRef<number>(undefined)
  const pending = useRef<{ path: string; text: string } | null>(null)
  const mtimes = useRef(new Map<string, number>())
  /** what each note held on disk when last read or saved: a save goes only over that (an agent may write it too) */
  const onDisk = useRef(new Map<string, string>())
  const asking = useRef(false)
  /** notes we have already said we cannot save over, so every keystroke does not toast again */
  const noBaseTold = useRef(new Set<string>())
  const currentRef = useRef<string | null>(null)
  currentRef.current = current
  const readingRef = useRef<HTMLDivElement>(null)

  useEffect(() => localStorage.setItem('fb.md.mode', mode), [mode])

  const paths = useMemo(() => (tree ? flattenFiles(tree).map((f) => f.path).filter(isMarkdownPath) : []), [tree])
  const ix = useMemo(() => buildIndex(paths, root), [paths, root])

  // ---------- loading ----------
  const loadTree = useCallback(async () => {
    if (!root) return []
    const t = await invoke<TreeEntry[]>('fs:tree', root, 8, MD_EXT).catch(() => [] as TreeEntry[])
    setTree(t)
    return t
  }, [root])

  /** a folder the first read left out, read once it is opened */
  const loadDir = useCallback(async (dir: string) => {
    const children = await invoke<TreeEntry[]>('fs:tree', dir, 1, MD_EXT).catch(() => null)
    if (children) setTree((t) => t && graft(t, dir, children))
  }, [])

  const loadAll = useCallback(async (t: TreeEntry[]) => {
    const list = flattenFiles(t).map((f) => f.path).filter(isMarkdownPath).slice(0, MAX_NOTES)
    const entries = await Promise.all(
      list.map(async (p) => {
        try {
          const text = await invoke<string>('fs:read', p)
          // this read is a base: without it a save over one of these notes would have nothing to
          // compare against, and fs:write would overwrite it unconditionally
          onDisk.current.set(p, text)
          return [p, text] as const
        } catch {
          // shown as empty, but nothing is recorded as its contents on disk: we did not read it
          return [p, ''] as const
        }
      })
    )
    setNotes((prev) => {
      const next = new Map(entries)
      // never clobber the note being edited with a stale disk read
      const pend = pending.current
      if (pend && next.has(pend.path)) next.set(pend.path, pend.text)
      for (const [k, v] of prev) if (!next.has(k) && list.includes(k)) next.set(k, v)
      return next
    })
  }, [])

  useEffect(() => {
    loadTree().then((t) => {
      setLoaded(true)
      loadAll(t)
    })
  }, [loadTree, loadAll])

  // ---------- saving ----------
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const p = pending.current
    if (!p || asking.current) return
    const base = onDisk.current.get(p.path)
    if (base === undefined) {
      // Never read successfully, so there is nothing to compare against and no idea what is in it.
      // A read can fail transiently (no permission, locked on Windows, removed between the tree read
      // and the open) and the editor then shows the empty fallback — writing that would replace the
      // real file, or an agent's work, with nothing. Keep the edit in hand instead.
      setSave('error')
      if (!noBaseTold.current.has(p.path)) {
        noBaseTold.current.add(p.path)
        toast(`${baseName(p.path)} could not be read, so it is not saved over. Open it again to edit it.`, 'error')
      }
      return
    }
    pending.current = null
    setSave('saving')
    try {
      const r = await invoke<WriteResult>('fs:write', p.path, p.text, { base })
      if (!r.ok) {
        // changed on disk since we read it: never overwrite that silently
        pending.current ??= p
        setSave('conflict')
        asking.current = true
        try {
          const app = useApp.getState()
          const disk = r.current
          if (await app.confirm({ title: `${baseName(p.path)} changed on disk`, body: `It was ${disk === null ? 'deleted' : 'changed'} while you were editing it, maybe by an agent. Replace it with your version?`, confirm: 'Replace with mine', danger: true })) {
            // p, not whatever is pending now: the answer is about the note the dialog named. And over
            // exactly what the user was shown — if it changed again while they read the dialog this
            // refuses and asks afresh, rather than overwriting a version nobody saw. A deleted file
            // has no base to give: then "replace with mine" means write it back.
            const again = await invoke<WriteResult>('fs:write', p.path, p.text, disk === null ? undefined : { base: disk })
            if (!again.ok) {
              pending.current ??= p
              setSave('conflict')
              toast(`${baseName(p.path)} changed again while you were deciding; your version is still unsaved.`, 'warn')
            } else {
              onDisk.current.set(p.path, p.text)
              if (pending.current?.path === p.path && pending.current.text === p.text) pending.current = null
              setSave(pending.current ? 'dirty' : 'saved')
            }
          } else if (disk !== null && (await app.confirm({ title: 'Load the version on disk?', body: 'Your edits since the last save are lost. Otherwise you keep yours, unsaved, and are asked again on the next save.', confirm: 'Load the version on disk', danger: true }))) {
            pending.current = null
            onDisk.current.set(p.path, disk)
            setNotes((m) => new Map(m).set(p.path, disk))
            if (currentRef.current === p.path) setText(disk)
            setSave('saved')
          }
        } finally {
          asking.current = false
          // flush() returns without re-arming while a dialog is up: anything still pending would
          // otherwise wait for the next keystroke or for unmount
          if (pending.current) {
            window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(flushRef.current, 600)
          }
        }
        return
      }
      onDisk.current.set(p.path, p.text)
      const st = await invoke<FileStat | null>('fs:stat', p.path)
      if (st) mtimes.current.set(p.path, st.mtime)
      if (!pending.current) setSave('saved')
    } catch (e: any) {
      setSave('error')
      toast(`Could not save ${baseName(p.path)}: ${e?.message ?? e}`, 'error')
    }
  }, [])

  // flush re-arms itself after a conflict dialog, which it cannot reference directly
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => () => void flush(), [flush])

  function edit(v: string) {
    if (!current) return
    setText(v)
    setNotes((m) => new Map(m).set(current, v))
    pending.current = { path: current, text: v }
    setSave('dirty')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 600)
  }

  // ---------- navigation ----------
  const open = useCallback(
    async (path: string, nextMode?: Mode) => {
      await flush()
      setCreating(null)
      setExpanded((s) => new Set([...s, ...ancestors(root, path)]))
      setCurrent(path)
      // now, not at the next render: the read below can finish first, and would then not show the note
      currentRef.current = path
      if (nextMode) setMode(nextMode)
      const cached = notes.get(path)
      if (cached != null) setText(cached)
      try {
        const [st, fresh] = await Promise.all([invoke<FileStat | null>('fs:stat', path), invoke<string>('fs:read', path)])
        if (st) mtimes.current.set(path, st.mtime)
        onDisk.current.set(path, fresh)
        if (currentRef.current === path) setText(fresh)
        setNotes((m) => new Map(m).set(path, fresh))
      } catch {
        if (cached == null) setText('')
        toast(`Could not open ${baseName(path)}; it will not be saved over until it reads`, 'error')
      }
      setSave('saved')
      readingRef.current?.scrollTo({ top: 0 })
    },
    [flush, notes, root]
  )

  // first note: requested path, else README, else the first one
  useEffect(() => {
    if (!loaded || current) return
    if (props.path) {
      open(props.path)
      return
    }
    const pick = paths.find((p) => /^readme\.mdx?$/i.test(relativeTo(root, p))) ?? paths.find((p) => dirname(p) === root) ?? paths[0]
    if (pick) open(pick)
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // pick up edits made outside (agents writing docs) while we have nothing pending
  useEffect(() => {
    if (!current) return
    const id = window.setInterval(async () => {
      const p = currentRef.current
      if (!p || pending.current || document.visibilityState !== 'visible') return
      const st = await invoke<FileStat | null>('fs:stat', p).catch(() => null)
      if (!st || st.mtime === mtimes.current.get(p)) return
      mtimes.current.set(p, st.mtime)
      const fresh = await invoke<string>('fs:read', p).catch(() => null)
      if (fresh == null || pending.current || currentRef.current !== p) return
      onDisk.current.set(p, fresh)
      setText(fresh)
      setNotes((m) => new Map(m).set(p, fresh))
    }, 3000)
    return () => window.clearInterval(id)
  }, [current])

  async function createNote(name: string, dir?: string) {
    const c = creating
    setCreating(null)
    const target = dir ?? c?.dir ?? root
    const clean = name.replace(/[\\:*?"<>|]/g, '-').trim()
    if (!clean) return
    const file = /\.(md|mdx)$/i.test(clean) ? clean : clean + '.md'
    const path = joinPath(target, file)
    if (!isInside(root, path) || !relativeTo(root, path)) return toast('Stay inside the project folder', 'warn')
    if (await invoke<boolean>('fs:exists', path)) return open(path)
    try {
      // base: null is "only if it is not there", so a note an agent wrote in the meantime is opened
      // rather than replaced by this empty stub
      const made = await invoke<WriteResult>('fs:write', path, `# ${stripExt(baseName(file))}\n\n`, { base: null })
      if (!made.ok) return open(path)
      const t = await loadTree()
      loadAll(t)
      await open(path, 'source')
      toast(`Created ${relativeTo(root, path)}`, 'ok')
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error')
    }
  }

  // ---------- links ----------
  const onWiki = (target: string) => {
    const hit = resolveWiki(ix, target, current)
    if (hit) return open(hit, mode === 'graph' ? 'reading' : undefined)
    const name = target.replace(/#.*$/, '').trim()
    if (name) createNote(name.split('/').pop()!, current ? dirname(current) : root)
  }

  const onFile = (abs: string) => {
    if (isMarkdownPath(abs)) {
      if (ix.set.has(abs)) open(abs)
      else toast(`${relativeTo(root, abs)} does not exist`, 'warn')
    } else invoke('shell:openPath', abs)
  }

  const html = useMemo(
    () => (current && mode === 'reading' ? renderMarkdown(text, { baseDir: dirname(current), wikiExists: (t) => !!resolveWiki(ix, t, current) }) : ''),
    [text, current, mode, ix]
  )

  const graph = useMemo(() => {
    if (mode !== 'graph') return { nodes: [] as GraphNode[], edges: [] as [string, string][] }
    const nodes = paths.map((p) => ({ id: p, label: stripExt(baseName(p)) }))
    const edges: [string, string][] = []
    for (const p of paths) {
      const src = notes.get(p)
      if (!src) continue
      const { wiki, files } = extractLinks(src)
      for (const w of wiki) {
        const t = resolveWiki(ix, w, p)
        if (t && t !== p) edges.push([p, t])
      }
      for (const f of files) {
        const t = resolveFile(ix, f, p, root)
        if (t && t !== p) edges.push([p, t])
      }
    }
    return { nodes, edges }
  }, [mode, paths, notes, ix, root])

  const contentMatch = useCallback(
    (p: string) => {
      const q = query.trim().toLowerCase()
      return q.length > 2 && !!notes.get(p)?.toLowerCase().includes(q)
    },
    [notes, query]
  )

  const title = current ? firstHeading(text) || stripExt(baseName(current)) : ''
  const rel = current ? relativeTo(root, current) : ''
  const crumbs = rel ? rel.split('/') : []
  const words = useMemo(() => (text.match(/\S+/g) ?? []).length, [text])

  function addToBoard() {
    if (!current) return
    flush()
    const app = useApp.getState()
    const id = app.addNode({ type: 'doc', title, data: { path: current } })
    app.closePanel()
    app.setSelection([id])
    toast(`Added ${title} to the board`, 'ok')
  }

  async function exportPdf() {
    if (!current) return
    await flush()
    setExporting(true)
    await exportMarkdownPdf(text, title, { defaultDir: dirname(current), fileName: stripExt(baseName(current)) })
    setExporting(false)
  }

  return (
    <Modal
      title="Markdown"
      sub={project?.name}
      icon={<BookOpenText size={17} />}
      width="min(1200px, 94vw)"
      height="86vh"
      bare
      onClose={() => {
        flush()
        useApp.getState().closePanel()
      }}
    >
      <div className="wbs">
        <aside className="wbs-side">
          <div className="wbs-side-head">
            <div className="wbs-search">
              <Search size={13} className="dim" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${paths.length} notes`} />
              {query && (
                <button className="icon-btn sm" onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              className="icon-btn sm"
              title="Refresh"
              onClick={async () => {
                const t = await loadTree()
                loadAll(t)
              }}
            >
              <RefreshCw size={13} />
            </button>
            <button
              className="icon-btn sm wb-accent-btn"
              title="New note"
              onClick={() => {
                setQuery('')
                const dir = current ? dirname(current) : root
                if (dir !== root) setExpanded((s) => new Set([...s, dir, ...ancestors(root, dir + '/x')]))
                setCreating({ dir, kind: 'file' })
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="wbs-tree scrollable">
            {!loaded ? (
              <div className="ftree-none">
                <Loader2 size={14} className="spin" />
              </div>
            ) : paths.length === 0 && !creating ? (
              <div className="wbs-none">
                <div className="dim">No markdown files in this project yet.</div>
                <button className="btn sm" onClick={() => setCreating({ dir: root, kind: 'file' })}>
                  <Plus size={12} /> New note
                </button>
              </div>
            ) : (
              <FileTree
                entries={tree ?? []}
                root={root}
                active={current}
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
                onOpen={(p) => open(p, mode === 'graph' ? 'reading' : undefined)}
                hideExt
                extraMatch={contentMatch}
                creating={creating}
                onCreate={(n) => createNote(n)}
                onCancelCreate={() => setCreating(null)}
              />
            )}
          </div>
        </aside>

        <section className="wbs-main">
          <div className="wbs-bar">
            <div className="wb-crumbs grow" title={current ?? ''}>
              {crumbs.length === 0 && <span className="dim">{mode === 'graph' ? 'Graph of all notes' : 'No note open'}</span>}
              {crumbs.map((c, i) => (
                <span key={i} className="row" style={{ gap: 4 }}>
                  {i > 0 && <ChevronRight size={11} className="dim" />}
                  <span className={i === crumbs.length - 1 ? 'wb-crumb-last' : 'wb-crumb'}>{i === crumbs.length - 1 ? stripExt(c) : c}</span>
                </span>
              ))}
              {current && mode === 'source' && (
                <span className={`wb-save-state ${save}`}>
                  {save === 'saving' ? (
                    <>
                      <Loader2 size={11} className="spin" /> Saving…
                    </>
                  ) : save === 'dirty' ? (
                    'Editing…'
                  ) : save === 'error' ? (
                    'Not saved'
                  ) : save === 'conflict' ? (
                    'Changed on disk: not saved'
                  ) : (
                    <>
                      <Check size={11} /> Saved
                    </>
                  )}
                </span>
              )}
            </div>
            <Seg<Mode>
              value={mode}
              onChange={(m) => {
                if (m !== 'source') flush()
                setMode(m)
              }}
              options={[
                { value: 'reading', label: 'Reading' },
                { value: 'source', label: 'Source' },
                { value: 'graph', label: 'Graph' }
              ]}
            />
            <button className="btn sm" onClick={addToBoard} disabled={!current} title="Place this note on the board as a document card">
              <LayoutDashboard size={13} /> Add to Board
            </button>
            <button className="btn sm primary" onClick={exportPdf} disabled={!current || exporting}>
              {exporting ? <Loader2 size={13} className="spin" /> : <FileDown size={13} />} Export PDF
            </button>
          </div>

          <div className="wbs-editor">
            {mode === 'graph' ? (
              paths.length ? (
                <LinkGraph nodes={graph.nodes} edges={graph.edges} current={current} onOpen={(p) => open(p, 'reading')} />
              ) : (
                <div className="empty">No notes to graph yet</div>
              )
            ) : !current ? (
              <div className="empty">
                <BookOpenText size={28} className="dim" />
                <div>{loaded ? 'Pick a note, or create one with +' : 'Loading vault…'}</div>
              </div>
            ) : mode === 'source' ? (
              <textarea
                key={current}
                className="wb-md-source scrollable"
                value={text}
                spellCheck={false}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    flush()
                  }
                }}
                autoFocus
              />
            ) : (
              <div className="wb-md-reading scrollable" ref={readingRef}>
                <div className="md wb-md-page" onClick={(e) => handleMdClick(e, { baseDir: dirname(current), onWiki, onFile })} dangerouslySetInnerHTML={{ __html: html }} />
                <div className="wb-md-foot dim small">
                  {words.toLocaleString()} words · {rel}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
