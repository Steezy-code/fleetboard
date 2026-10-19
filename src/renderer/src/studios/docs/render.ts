import { marked } from 'marked'
import { sanitizeHtml as sanitize } from '../../workbench/markdown'

// Markdown → HTML for the paper preview. The model writes the markdown (and a repo can steer the
// model), so it goes through the app's one allowlist sanitizer before it reaches innerHTML.

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${sanitize(html)}</body>`, 'text/html')
  // "> **NOTE** — ..." callouts get their own look
  doc.querySelectorAll('blockquote').forEach((bq) => {
    const first = bq.querySelector('p > strong:first-child, strong:first-child')
    if (first && /^(note|tip|warning|important|caution)\b/i.test(first.textContent ?? '')) {
      bq.classList.add('callout', `callout-${(first.textContent ?? 'note').toLowerCase().replace(/[^a-z]/g, '')}`)
    }
  })
  return doc.body.innerHTML
}

export function renderMarkdown(md: string): string {
  if (!md) return ''
  const html = marked.parse(md, { async: false, gfm: true }) as string
  return sanitizeHtml(html)
}
