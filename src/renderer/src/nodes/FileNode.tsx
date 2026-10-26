import { useEffect, useMemo, useRef, useState } from 'react'
import { Code2, Eye, FolderOpen, SquarePen } from 'lucide-react'
import type { NodeProps } from './types'
import { fileUrl, invoke } from '../lib/api'
import { useApp } from '../state/store'
import { useFileText } from '../workbench/useFileText'
import { CodeEditor } from '../workbench/CodeEditor'
import { handleMdClick, isImagePath, isMarkdownPath, langFromPath, langLabel, renderMarkdown } from '../workbench/markdown'
import { FileIcon } from '../workbench/icons'
import { baseName, dirname, relativeTo } from '../workbench/paths'
import { AsciiSkeleton } from 'ascii-reveal'

interface FileData {
  path?: string
  /** markdown files: show the source instead of the rendered view */
  source?: boolean
}

/** A file pinned to the board: highlighted code with line numbers, or rendered markdown. Live-reloads. */
export default function FileNode({ node, zoom }: NodeProps<FileData>) {
  const path = node.data?.path
  const root = useApp((s) => s.project?.path ?? '')
  const image = !!path && isImagePath(path)
  const file = useFileText(image ? null : path, 3000)
  const md = !!path && isMarkdownPath(path)
  const showSource = !!node.data?.source
  const lang = path ? langFromPath(path) : 'plaintext'

  // the frame header shows node.title: name the node after its file
  useEffect(() => {
    if (path && !node.title) useApp.getState().updateNode(node.id, { title: baseName(path) })
  }, [path, node.id, node.title])

  const html = useMemo(() => (md && !showSource && file.text != null ? renderMarkdown(file.text, { baseDir: dirname(path!) }) : ''), [md, showSource, file.text, path])
  const lines = file.text != null ? file.text.split('\n').length : 0

  // flash on external change
  const [flash, setFlash] = useState(false)
  const prevMtime = useRef(0)
  useEffect(() => {
    const prev = prevMtime.current
    prevMtime.current = file.mtime
    if (!file.mtime || !prev || prev === file.mtime) return
    setFlash(true)
    const t = window.setTimeout(() => setFlash(false), 700)
    return () => window.clearTimeout(t)
  }, [file.mtime])

  if (!path) return <div className="empty">No file</div>
  const rel = relativeTo(root, path)

  return (
    <div className={`fnode ${flash ? 'flash' : ''}`}>
      <div className="fnode-bar">
        <FileIcon name={baseName(path)} size={12} />
        <span className="fnode-path" title={path}>
          {rel.includes('/') ? dirname(rel) + '/' : ''}
          <b>{baseName(path)}</b>
        </span>
        <span className="spacer" />
        {!image && file.text != null && (
          <span className="dim small fnode-meta">
            {md && !showSource ? 'Markdown' : langLabel(lang)} · {lines} lines
          </span>
        )}
        {md && (
          <button
            className="icon-btn sm"
            title={showSource ? 'Show rendered' : 'Show source'}
            onClick={() => useApp.getState().updateNodeData(node.id, { source: !showSource })}
          >
            {showSource ? <Eye size={12} /> : <Code2 size={12} />}
          </button>
        )}
        {!image && (
          <button className="icon-btn sm" title="Edit in Code studio" onClick={() => useApp.getState().openPanel(md ? 'markdown' : 'code', { path })}>
            <SquarePen size={12} />
          </button>
        )}
        <button className="icon-btn sm" title="Show in folder" onClick={() => invoke('shell:showItem', path)}>
          <FolderOpen size={12} />
        </button>
      </div>
      <div className="fnode-body">
        {image ? (
          <div className="fnode-img no-board-wheel">
            <img src={fileUrl(path)} alt={baseName(path)} draggable={false} />
          </div>
        ) : file.loading ? (
          <div className="empty">
            <AsciiSkeleton variant="terminal" lines={6} widths={['80%', '65%', '90%', '55%', '70%', '40%']} />
          </div>
        ) : file.error || file.binary ? (
          <div className="empty">
            <div>{file.binary ? 'Binary file' : file.error}</div>
            <button className="btn sm" onClick={() => invoke('shell:openPath', path)}>
              Open with system app
            </button>
          </div>
        ) : md && !showSource ? (
          <div className="fnode-md md scrollable no-board-wheel" onClick={(e) => handleMdClick(e, { baseDir: dirname(path), onFile: (p) => openFileNear(node.id, p) })} dangerouslySetInnerHTML={{ __html: html }} />
        ) : zoom < 0.18 ? (
          <div className="fnode-far">
            <FileIcon name={baseName(path)} size={42} />
          </div>
        ) : (
          <CodeEditor value={file.text ?? ''} language={lang} readOnly className="fnode-code" />
        )}
      </div>
    </div>
  )
}

/** Open a linked file as another file node next to this one. */
function openFileNear(id: string, path: string) {
  const app = useApp.getState()
  const ws = app.project?.workspaces.find((w) => w.id === app.project?.activeWorkspaceId)
  const n = ws?.nodes.find((x) => x.id === id)
  app.addNode({ type: 'file', title: baseName(path), data: { path }, ...(n ? { x: n.x + n.w + 30, y: n.y } : {}) })
}
