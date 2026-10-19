// Small formatting helpers for usage numbers and times.

export function fmtTokens(n: number, digits = 1): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${trim((n / 1e9).toFixed(digits))}B`
  if (a >= 1e6) return `${trim((n / 1e6).toFixed(digits))}M`
  if (a >= 1e3) return `${trim((n / 1e3).toFixed(a >= 1e5 ? 0 : digits))}K`
  return String(Math.round(n))
}
const trim = (s: string) => s.replace(/\.0+$/, '')

export const fmtInt = (n: number) => Math.round(n).toLocaleString()

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 48) return r ? `${h}h ${r}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** "12:39am" */
export function fmtClock(t: number): string {
  const d = new Date(t)
  let h = d.getHours()
  const ap = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`
}

/** "12:39am", "Tue 4:59am" or "Oct 21" depending on distance */
export function fmtReset(t: number | null): string {
  if (!t) return '—'
  const now = Date.now()
  const d = new Date(t)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return fmtClock(t)
  if (t - now < 6 * 86400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${fmtClock(t)}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fmtUntil(t: number | null): string {
  if (!t) return ''
  const ms = t - Date.now()
  if (ms <= 0) return 'now'
  return `in ${fmtDuration(ms)}`
}

/** "2026-10-06" → "Oct 6" (or "Tue, Oct 6" with weekday) */
export function fmtDay(key: string, weekday = false): string {
  const d = new Date(key + 'T00:00:00')
  return d.toLocaleDateString(undefined, weekday ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })
}

/** "claude-opus-5-5" → "Opus 5.5" ; "gpt-5-codex" stays readable */
export function prettyModel(m: string | null | undefined): string {
  if (!m) return '—'
  const c = /^claude-(?:3-5-|3-7-|3-)?([a-z]+)-?([\d-]*)/.exec(m)
  if (c) {
    const fam = c[1][0].toUpperCase() + c[1].slice(1)
    const ver = c[2]
      .split('-')
      .filter((x) => x && x.length < 3)
      .join('.')
    return ver ? `${fam} ${ver}` : fam
  }
  return m
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'
