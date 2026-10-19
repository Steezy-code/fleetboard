import { marked } from 'marked'

// Markdown → HTML for the paper preview. The model writes the markdown, so strip anything active
// (scripts, event handlers, javascript: links) before it reaches innerHTML.

const BLOCKED = 'script,iframe,object,embed,style,link,meta,base,form,input,button,textarea,select'

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.querySelectorAll(BLOCKED).forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const val = attr.value.trim().toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(javascript|vbscript|data:text)/.test(val))
        el.removeAttribute(attr.name)
    }
  })
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
