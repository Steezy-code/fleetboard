import { useMemo, useState } from 'react'
import { FileDown, Loader2, SquarePen } from 'lucide-react'
import type { NodeProps } from './types'
import { useApp } from '../state/store'
import { useFileText } from '../workbench/useFileText'
import { handleMdClick, renderMarkdown } from '../workbench/markdown'
import { exportMarkdownPdf } from '../workbench/pdf'
import { baseName, dirname, stripExt } from '../workbench/paths'

interface DocData {
  /** inline markdown (documents studio output) */
  markdown?: string
  /** or a .md file on disk (markdown vault "Add to Board") */
  path?: string
  title?: string
  /** still being written (documents studio streaming) */
  streaming?: boolean
}

/** Strip a leading "# Title" so the paper header doesn't repeat it. */
function splitTitle(md: string): { h1: string | null; body: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*(\n|$)/.exec(md)
  if (!m) return { h1: null, body: md }
  return { h1: (m[1] ?? '').replace(/[*_`]/g, '').trim(), body: md.slice(m[0].length) }
}

/** A document on a white paper card: DOCUMENT eyebrow, title, rendered markdown, Export PDF. */
export default function DocNode({ node }: NodeProps<DocData>) {
  const d = node.data ?? {}
  const file = useFileText(d.markdown == null ? d.path : null, 3000)
  const src = d.markdown ?? file.text ?? ''
  const { h1, body } = useMemo(() => splitTitle(src), [src])
  const title = d.title || h1 || node.title || (d.path ? stripExt(baseName(d.path)) : 'Untitled document')
  const baseDir = d.path ? dirname(d.path) : useApp.getState().project?.path
  const html = useMemo(() => renderMarkdown(body, { baseDir, wiki: 'text' }), [body, baseDir])
  const [exporting, setExporting] = useState(false)
  const words = useMemo(() => (src.match(/\S+/g) ?? []).length, [src])

  async function exportPdf() {
    setExporting(true)
    const md = h1 ? src : `# ${title}\n\n${src}`
    await exportMarkdownPdf(md, title, { defaultDir: useApp.getState().project?.path, fileName: title })
    setExporting(false)
  }

  const loading = d.markdown == null && d.path && file.loading
  const error = d.markdown == null && d.path ? file.error : null

  return (
    <div className="docnode scrollable no-board-wheel">
      <div className="doc-paper">
        <div className="doc-top">
          <span className="doc-eyebrow">Document</span>
          {d.streaming && (
            <span className="doc-live">
              <Loader2 size={10} className="spin" /> writing
            </span>
          )}
          <span className="spacer" />
          <span className="doc-words">{words.toLocaleString()} words</span>
          {d.path && (
            <button className="doc-btn" title="Open in the Markdown vault" onClick={() => useApp.getState().openPanel('markdown', { path: d.path })}>
              <SquarePen size={12} />
            </button>
          )}
          <button className="doc-btn primary" onClick={exportPdf} disabled={exporting || !src.trim()} title="Export as PDF">
            {exporting ? <Loader2 size={12} className="spin" /> : <FileDown size={12} />} Export PDF
          </button>
        </div>
        <div className="md paper doc-md" onClick={(e) => handleMdClick(e, { baseDir })}>
          <h1>{title}</h1>
          {loading ? (
            <p className="doc-dim">Loading…</p>
          ) : error ? (
            <p className="doc-dim">{error}</p>
          ) : !src.trim() ? (
            <p className="doc-dim">Empty document</p>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>
  )
}
