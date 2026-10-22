// Path helpers for the renderer (no node:path here). They take POSIX and Windows paths (C:\dir, C:/dir,
// \\server\share) and give back forward slashes, which Windows accepts everywhere.

const DRIVE = /^[A-Za-z]:/
export const toSlash = (p: string) => p.replace(/\\/g, '/')
/** Windows paths compare without case */
const key = (p: string) => (DRIVE.test(p) || p.startsWith('//') ? p.toLowerCase() : p)

export function normalize(p: string): string {
  const s = toSlash(p)
  const drive = DRIVE.exec(s)?.[0] ?? ''
  const rest = drive ? s.slice(2) : s
  const unc = !drive && rest.startsWith('//')
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
    } else out.push(seg)
  }
  return drive + (unc ? '//' : abs ? '/' : '') + out.join('/')
}

export const joinPath = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'))

export function dirname(p: string): string {
  const s = toSlash(p).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (DRIVE.test(s) && i <= 2) return s.slice(0, 2) + '/'
  return i <= 0 ? '/' : s.slice(0, i)
}

export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** `file.test.ts` → `file.test`. A dotfile is all name: `.gitignore` kept giving back nothing. */
export const stripExt = (name: string) => name.replace(/(?!^)\.[^./\\]+$/, '')

/** p relative to root ('' for root itself); p unchanged (forward slashes) when it is outside root. */
export function relativeTo(root: string, p: string): string {
  const r = normalize(root).replace(/\/+$/, '')
  const q = normalize(p)
  if (key(q) === key(r)) return ''
  return key(q).startsWith(key(r) + '/') ? q.slice(r.length + 1) : q
}

/** Is p root itself or inside it? */
export const isInside = (root: string, p: string) => {
  const r = key(normalize(root).replace(/\/+$/, ''))
  const q = key(normalize(p))
  return q === r || q.startsWith(r + '/')
}

/** "LucioSiancas/Votelanding" → "LucioSianc…Votelanding" when too long */
export function midTruncate(s: string, max = 26): string {
  if (s.length <= max) return s
  const slash = s.indexOf('/')
  if (slash > 0) {
    const owner = s.slice(0, slash)
    const repo = s.slice(slash + 1)
    const keep = Math.max(4, max - repo.length - 1)
    if (repo.length < max - 4) return owner.slice(0, keep) + '…' + repo
  }
  const head = Math.ceil((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head))
}
