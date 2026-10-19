// POSIX path helpers for the renderer (no node:path here).

export function normalize(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
    } else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

export const joinPath = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'))

export function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

export const stripExt = (name: string) => name.replace(/\.[^./]+$/, '')

export function relativeTo(root: string, p: string): string {
  const r = root.replace(/\/+$/, '')
  if (p === r) return ''
  return p.startsWith(r + '/') ? p.slice(r.length + 1) : p
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
