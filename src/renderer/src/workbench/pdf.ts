import { errorText, invoke, request } from '../lib/api'
import { useApp } from '../state/store'
import { escapeHtml, firstHeading, renderMarkdown } from './markdown'

// Print-styled standalone HTML for markdown documents, rendered to PDF by the main process (pdf:fromHtml).

const PRINT_CSS = `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:#1b1917;font:10.5pt/1.62 "Geist Variable","Geist","Inter",-apple-system,"Segoe UI",system-ui,sans-serif;font-feature-settings:"ss01","cv11"}
main{max-width:100%;padding:0}
.eyebrow{font:600 7.5pt/1 "Geist","Inter",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#ff4a2b;margin:0 0 10pt}
h1,h2,h3,h4{color:#111;line-height:1.25;break-after:avoid;page-break-after:avoid}
h1{font-family:"Fraunces Variable","Fraunces",Georgia,"Times New Roman",serif;font-style:italic;font-weight:500;font-size:25pt;letter-spacing:-.01em;margin:0 0 14pt}
h1::after{content:"";display:block;width:42pt;height:3pt;border-radius:2pt;background:#ff4a2b;margin-top:10pt}
h2{font-size:14.5pt;font-weight:650;margin:22pt 0 7pt;padding-bottom:4pt;border-bottom:1px solid #ece8e3}
h3{font-size:11.5pt;font-weight:650;margin:16pt 0 5pt}
h4{font-size:10.5pt;font-weight:650;margin:12pt 0 4pt;color:#3a332e}
p{margin:0 0 8pt;orphans:3;widows:3}
a{color:#d2391c;text-decoration:none;border-bottom:1px solid rgba(210,57,28,.3)}
strong{font-weight:650;color:#111}
ul,ol{margin:0 0 9pt;padding-left:17pt}
li{margin:2pt 0}
li>p{margin:0}
li input[type=checkbox]{margin:0 5pt 0 -14pt;vertical-align:-1pt}
blockquote{margin:10pt 0;padding:7pt 12pt;border-left:3pt solid #ff4a2b;background:#fdf3f0;color:#4a3f39;border-radius:0 4pt 4pt 0}
blockquote p:last-child{margin:0}
hr{border:0;border-top:1px solid #e5e1dc;margin:16pt 0}
code{font-family:"JetBrains Mono Variable","JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:8.6pt;color:#c2361d;background:#fbece7;padding:.5pt 3.5pt;border-radius:3pt}
pre{background:#f6f4f1;border:1px solid #e7e2dc;border-radius:5pt;padding:9pt 11pt;margin:0 0 10pt;overflow:hidden;white-space:pre-wrap;word-break:break-word;break-inside:avoid;page-break-inside:avoid}
pre code{background:none;color:#2a2623;padding:0;font-size:8.2pt;line-height:1.55}
table{border-collapse:collapse;width:100%;margin:6pt 0 12pt;font-size:9.2pt;break-inside:auto}
tr{break-inside:avoid;page-break-inside:avoid}
th,td{border:1px solid #e5e1dc;padding:5pt 7pt;text-align:left;vertical-align:top}
th{background:#f3f1ee;font-weight:650;color:#111}
tbody tr:nth-child(even) td{background:#fbfaf8}
img{max-width:100%;break-inside:avoid}
.wikilink{color:#d2391c}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-meta{color:#c2361d}
.hljs-string,.hljs-attr,.hljs-regexp{color:#8a5a00}
.hljs-number,.hljs-literal{color:#7c3aed}
.hljs-comment,.hljs-quote{color:#8f857b;font-style:italic}
.hljs-title,.hljs-title.function_,.hljs-section{color:#0f766e}
.hljs-type,.hljs-title.class_{color:#1d4ed8}
.hljs-tag,.hljs-name{color:#b45309}
.hljs-variable,.hljs-params{color:#2a2623}
.hljs-addition{color:#15803d;background:#ecfdf3}
.hljs-deletion{color:#b91c1c;background:#fef2f2}
`

/**
 * Build a standalone, print-styled HTML document (A4, typography, code, tables, accent rule under H1)
 * from markdown. Used by the Documents studio, the Markdown studio and the doc node.
 */
export function markdownToHtmlDocument(md: string, title: string): string {
  const src = md ?? ''
  const t = (title ?? '').trim() || firstHeading(src) || 'Document'
  // keep the document's own H1 when it has one; otherwise put the title on top
  const hasH1 = !!firstHeading(src)
  const body = renderMarkdown(src, { wiki: 'text', localImages: false })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(t)}</title>
<style>${PRINT_CSS}</style></head>
<body><main>${hasH1 ? '' : `<h1>${escapeHtml(t)}</h1>`}${body}</main></body></html>`
}

const safeFileName = (s: string) =>
  (s || 'document')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document'

/** Ask for a destination and write a PDF of the markdown. Returns the path, or null when cancelled. */
export async function exportMarkdownPdf(md: string, title: string, opts: { defaultDir?: string; fileName?: string } = {}): Promise<string | null> {
  const app = useApp.getState()
  const name = safeFileName(opts.fileName ?? title) + '.pdf'
  const def = opts.defaultDir ? `${opts.defaultDir.replace(/\/+$/, '')}/${name}` : name
  const out = await invoke<string | null>('dialog:saveFile', def, [{ name: 'PDF', extensions: ['pdf'] }])
  if (!out) return null
  try {
    await request('pdf:fromHtml', markdownToHtmlDocument(md, title), out)
    app.toast(`Exported ${out.split('/').pop()}`, 'ok')
    return out
  } catch (e: any) {
    app.toast(`PDF export failed: ${errorText(e)}`, 'error')
    return null
  }
}
