import { Marked, type Tokens } from 'marked'
import hljs from 'highlight.js/lib/common'
import { fileUrl, invoke } from '../lib/api'
import { dirname, joinPath } from './paths'

// Markdown + code highlighting shared by the file/doc nodes, the studios and the PDF export.
// Output is sanitized (local repos can contain hostile HTML; the renderer has IPC access).

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python', pyi: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objectivec', mm: 'objectivec',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  sql: 'sql', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff', vb: 'vbnet', wat: 'wasm'
}

const FILE_LANG: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'bash', gemfile: 'ruby', rakefile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.gitignore': 'ini', '.env': 'ini', '.npmrc': 'ini', '.editorconfig': 'ini'
}

const LANG_NAME: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', xml: 'HTML / XML', css: 'CSS', scss: 'SCSS', less: 'Less',
  markdown: 'Markdown', python: 'Python', ruby: 'Ruby', rust: 'Rust', go: 'Go', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', objectivec: 'Objective-C', csharp: 'C#', php: 'PHP', bash: 'Shell', yaml: 'YAML', ini: 'Config', sql: 'SQL',
  lua: 'Lua', perl: 'Perl', r: 'R', graphql: 'GraphQL', diff: 'Diff', makefile: 'Makefile', vbnet: 'VB.NET', wasm: 'WebAssembly',
  plaintext: 'Plain text'
}

export function langFromPath(p: string): string {
  const name = p.split('/').pop()!.toLowerCase()
  if (FILE_LANG[name]) return FILE_LANG[name]
  if (name.startsWith('.env')) return 'ini'
  if (name.startsWith('dockerfile')) return 'bash'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] ?? 'plaintext'
}

export const langLabel = (lang: string) => LANG_NAME[lang] ?? lang

export const isMarkdownPath = (p: string) => /\.(md|mdx|markdown)$/i.test(p)
export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p)

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Highlighted HTML for a whole file (falls back to escaped text for unknown or huge input). */
export function highlightCode(code: string, lang: string): string {
  if (code.length > 600_000 || lang === 'plaintext' || !hljs.getLanguage(lang)) return escapeHtml(code)
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

// ---------- markdown ----------

export interface MdOptions {
  /** directory of the markdown file, for relative images and links */
  baseDir?: string
  /** how [[wiki links]] render: clickable anchors (vault) or plain text (PDF) */
  wiki?: 'link' | 'text'
  /** returns true when a wiki target exists (unresolved links render dimmed) */
  wikiExists?: (target: string) => boolean
  /** image sources: rewrite relative paths to fbfile:// (default) or leave them */
  localImages?: boolean
  /** mark "> **NOTE** — …" blockquotes as callouts, so a document can give them their own look */
  callouts?: boolean
}

let current: MdOptions = {}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href)

const md = new Marked({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start(src: string) {
        const i = src.indexOf('[[')
        return i < 0 ? undefined : i
      },
      tokenizer(src: string) {
        const m = /^\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/.exec(src)
        if (!m) return undefined
        const target = (m[1] ?? '').trim()
        return { type: 'wikilink', raw: m[0], target, label: (m[2] ?? target.replace(/#.*$/, '')).trim() }
      },
      renderer(token: any) {
        const label = escapeHtml(token.label)
        if (current.wiki === 'text') return `<span class="wikilink">${label}</span>`
        const ok = current.wikiExists ? current.wikiExists(token.target) : true
        return `<a class="wikilink${ok ? '' : ' unresolved'}" data-wiki="${escapeHtml(token.target)}" href="#">${label}</a>`
      }
    }
  ],
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = ((lang ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase()
      const language = l && hljs.getLanguage(l) ? l : ''
      const body = language ? highlightCode(text, language) : escapeHtml(text)
      return `<pre><code class="hljs${language ? ' language-' + language : ''}">${body}</code></pre>\n`
    },
    heading({ tokens, depth }: Tokens.Heading) {
      const inner = this.parser.parseInline(tokens)
      return `<h${depth} id="${slugify(inner)}">${inner}</h${depth}>\n`
    },
    image({ href, title, text }: Tokens.Image) {
      let src = href ?? ''
      if (src && !isExternal(src) && !src.startsWith('#') && current.baseDir && current.localImages !== false) {
        const abs = src.startsWith('/') ? src : joinPath(current.baseDir, decodeURI(src.replace(/[?#].*$/, '')))
        src = fileUrl(abs)
      }
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? '')}"${title ? ` title="${escapeHtml(title)}"` : ''}>`
    }
  }
})

/** Render markdown to sanitized HTML. */
export function renderMarkdown(src: string, opts: MdOptions = {}): string {
  current = opts
  try {
    const html = md.parse(src ?? '', { async: false }) as string
    return sanitizeHtml(html)
  } catch {
    return `<pre>${escapeHtml(String(src ?? ''))}</pre>`
  } finally {
    current = {}
  }
}

// ---------- sanitizer ----------

const ALLOWED_TAGS = new Set(
  (
    'a abbr b blockquote br caption center code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd ' +
    'li mark ol p picture pre q s samp section small span strong sub summary sup table tbody td tfoot th thead tr u ul var'
  ).split(' ')
)
const DROP_TAGS = new Set('script style iframe frame frameset object embed applet template noscript form textarea select option button link meta base svg math audio video source track canvas dialog portal'.split(' '))
const ALLOWED_ATTRS = new Set('href src alt title class align width height colspan rowspan type checked disabled start id open data-wiki lang dir'.split(' '))

const RELATIVE_BASE = 'https://relative.invalid/'

/**
 * The URL as a browser will use it, or null when it must not be. Decided with the browser's own URL
 * parser: it drops tabs, newlines and leading control characters, so "java&#9;script:" is javascript:.
 */
export function safeUrl(v: string, kind: 'href' | 'src'): string | null {
  const s = v.trim()
  if (!s || s.startsWith('#')) return s
  let u: URL
  try {
    u = new URL(s, RELATIVE_BASE)
  } catch {
    return null
  }
  // "//host/x" and "\\host\x" name another machine, not a file here: in the packaged app, whose page is
  // a file:// URL, one in an <img> is a UNC path, and Windows sends the user's credentials to fetch it
  if (/^[\s\u0000-\u001f]*[\\/][\s\u0000-\u001f]*[\\/]/.test(s)) return null
  // a path in the document's folder (images, links to other files)
  if (u.origin === new URL(RELATIVE_BASE).origin && !/^[\s\u0000-\u001f]*[a-z][a-z0-9+.\-\s\u0000-\u001f]*:/i.test(s)) return s
  if (u.protocol === 'https:' || u.protocol === 'http:' || (kind === 'href' && u.protocol === 'mailto:')) return s
  if (kind === 'src' && u.protocol === 'fbfile:') return s
  if (kind === 'src' && u.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(s)) return s
  return null
}

export function sanitizeHtml(html: string, opts?: MdOptions): string {
  const callouts = opts?.callouts ?? current.callouts
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (DROP_TAGS.has(tag)) {
        child.remove()
        continue
      }
      if (!ALLOWED_TAGS.has(tag)) {
        walk(child)
        child.replaceWith(...Array.from(child.childNodes))
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        if (!ALLOWED_ATTRS.has(name)) {
          child.removeAttribute(attr.name)
          continue
        }
        if (name === 'href' || name === 'src') {
          const ok = safeUrl(attr.value, name)
          if (ok == null) child.removeAttribute(attr.name)
        }
      }
      if (tag === 'input') {
        if ((child.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') {
          child.remove()
          continue
        }
        child.setAttribute('disabled', '')
      }
      if (tag === 'a') {
        const href = child.getAttribute('href') ?? ''
        if (/^https?:/i.test(href)) child.setAttribute('target', '_blank')
      }
      // in the same pass the sanitizer is already making, rather than a second parse of the result
      if (tag === 'blockquote' && callouts) {
        const lead = child.querySelector('p > strong:first-child, strong:first-child')?.textContent ?? ''
        const kind = /^(note|tip|warning|important|caution)\b/i.exec(lead)?.[1]
        if (kind) child.classList.add('callout', `callout-${kind.toLowerCase()}`)
      }
      walk(child)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

// ---------- links ----------

export interface MdClickHandlers {
  baseDir?: string
  /** a [[wiki]] link was clicked */
  onWiki?: (target: string) => void
  /** a relative link to another file was clicked (absolute path, anchor without '#') */
  onFile?: (path: string, anchor?: string) => void
}

/**
 * Delegated click handler for rendered markdown: never lets the app window navigate.
 * External links open in the browser; #anchors scroll inside the container.
 */
export function handleMdClick(e: React.MouseEvent<HTMLElement>, h: MdClickHandlers = {}) {
  const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
  if (!a || !e.currentTarget.contains(a)) return
  e.preventDefault()
  e.stopPropagation()
  const wiki = a.getAttribute('data-wiki')
  if (wiki != null) return h.onWiki?.(wiki)
  const href = a.getAttribute('href') ?? ''
  if (!href) return
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1))
    const el = e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    invoke('shell:openExternal', href)
    return
  }
  if (isExternal(href)) return
  const [file = '', anchor] = href.split('#')
  const rel = decodeURI(file)
  const abs = rel.startsWith('/') ? rel : joinPath(h.baseDir ?? '/', rel)
  if (h.onFile) h.onFile(abs, anchor)
  else invoke('shell:openPath', abs)
}

/** Raw link targets of a note: [[wiki]] names and relative .md hrefs (code blocks ignored). */
export function extractLinks(src: string): { wiki: string[]; files: string[] } {
  const text = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const wiki: string[] = []
  const files: string[] = []
  for (const m of text.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) wiki.push((m[1] ?? '').trim())
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+?\.(?:md|mdx|markdown))(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/gi)) {
    const link = m[1] ?? ''
    if (!isExternal(link)) {
      try {
        files.push(decodeURI(link))
      } catch {
        files.push(link)
      }
    }
  }
  return { wiki, files }
}

/** First "# Heading" of a markdown string. */
export function firstHeading(src: string): string | null {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(src.replace(/```[\s\S]*?```/g, ''))
  return m?.[1] ? m[1].replace(/[*_`]/g, '').trim() : null
}

export { dirname }
