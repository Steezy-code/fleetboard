// What the team actually did, held against what it was told to do — read just before the user merges.
//
// Everything here is derived from fleet state alone: at fleet_finish the crew is still in
// s.members (dismissTeam only runs once the user merges), so each worker's owns/doneWhen/report
// are all still there to check the lead's Ready card against.

import type { FleetMember, FleetState } from './fleet'

/** A worker's done_when, and whether its own report backs it up. */
export interface Claim {
  who: string
  /** its worktree — the join key for what it spent getting here */
  cwd: string
  /** the check the lead promised would prove this task done */
  doneWhen: string
  /** the worker's own words on what it ran, when it got that far */
  report?: string
  /** it reported done and the lead merged it */
  proven: boolean
  /** why it isn't proven, for the ones that aren't */
  gap?: 'never reported' | 'reported but not merged' | 'still working' | 'blocked or stopped'
}

/**
 * A changed file worth a second look, and every reason it is. One entry per file: a file that is
 * both outside the granted scope and sensitive says so once, rather than being listed under two
 * headings.
 */
export interface FileFlag {
  path: string
  /** no member was granted this file */
  outside: boolean
  /** the charter's won't-touch entry this file falls under: the user ruled it out whoever was granted it */
  excluded?: string
  /** why it is worth a look whoever owns it */
  why?: string
}

export interface MergeReview {
  /** excluded files first, then outside-the-scope ones, then the merely sensitive */
  flags: FileFlag[]
  claims: Claim[]
  /** a file in the diff is one the charter ruled out */
  blocked: boolean
  /** nothing is blocked, every file in the diff was inside someone's owns, and every claim is proven */
  clean: boolean
}

/** Paths worth a second look whoever changed them, matched against the diff. */
const RISKS: { why: string; hit: (p: string) => boolean }[] = [
  { why: 'changes dependencies', hit: (p) => /(^|\/)package(-lock)?\.json$/.test(p) },
  { why: 'changes the build or packaging', hit: (p) => /(^|\/)(electron-builder\.yml|electron\.vite\.config\.ts)$/.test(p) },
  { why: 'changes CI', hit: (p) => p.startsWith('.github/') },
  { why: 'relaxes or tightens typechecking', hit: (p) => /(^|\/)tsconfig[^/]*\.json$/.test(p) },
  { why: 'looks like a database migration', hit: (p) => /migrat/i.test(p) },
  { why: 'looks like a credential', hit: (p) => /(^|\/)\.env($|\.)|\.(pem|key|p12|pfx)$/i.test(p) }
]

/** git reports forward slashes; `owns` comes from an agent and may not. */
export const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * Does one entry cover `f` (already `norm`ed)? An entry is either the file itself, a folder
 * containing it, or a trailing-`*` prefix.
 *
 * ponytail: exact / folder-prefix / trailing-star only, no real globbing. If agents start writing
 * `src/**\/*.ts` in owns or wontTouch, swap the body for a glob matcher — the callers don't change.
 * The two fail differently: an owns entry that matches nothing over-flags, but a wontTouch entry that
 * matches nothing excludes nothing, so a glob or a description there is held only by the worker's brief.
 */
const covers = (f: string, raw: string): boolean => {
  const o = norm(raw)
  if (!o) return false
  if (o.endsWith('*')) return f.startsWith(o.slice(0, -1))
  return f === o || f.startsWith(`${o}/`)
}

/** Is `file` inside one of `owns`? */
export function ownedBy(file: string, owns: string[] | undefined): boolean {
  const f = norm(file)
  return (owns ?? []).some((raw) => covers(f, raw))
}

/**
 * An exclusion in the form `covers` can match, or null for one that must not be used at all.
 * Exclusions alone go through this: `owns` is a grant, where a leading slash or a glob that matches
 * nothing only over-flags, while here it would silently protect nothing — or, for a bare `*`,
 * everything, refusing a merge over a rule the user was never shown.
 */
const asExclusion = (raw: string): string | null => {
  const o = norm(raw)
    .replace(/^\/+/, '')
    .replace(/\/\*\*(\/\*)?$/, '/*')
  return o && !/^\*+$/.test(o) ? o : null
}

/** The `wontTouch` entry that covers `file`, as it was written, or null. */
export function excludedBy(file: string, wontTouch: string[] | undefined): string | null {
  const f = norm(file)
  return (
    (wontTouch ?? []).find((raw) => {
      const o = asExclusion(raw)
      return o !== null && covers(f, o)
    }) ?? null
  )
}

const gapOf = (m: FleetMember): Claim['gap'] | undefined => {
  if (m.status === 'merged') return undefined
  if (m.status === 'working' || m.status === 'starting') return m.report ? 'reported but not merged' : 'still working'
  if (m.status === 'reported') return 'reported but not merged'
  return m.report ? 'blocked or stopped' : 'never reported'
}

/**
 * The crew under this lead, oldest first. Reviewers get no owns/done_when when they are spawned, so
 * they carry no claim and own nothing — they are left out of both halves of the review.
 */
const crewOf = (s: FleetState, leadId: string) =>
  Object.values(s.members)
    .filter((m) => m.leadId === leadId && m.role === 'worker')
    .sort((a, b) => a.createdAt - b.createdAt)

/** null when there is nothing to review (no Ready card, or one with no diff behind it). */
export function reviewReady(s: FleetState): MergeReview | null {
  const r = s.ready
  if (!r) return null
  const crew = crewOf(s, r.leadId)
  const lead = s.members[r.leadId]

  const claims: Claim[] = crew
    .filter((m) => m.doneWhen)
    .map((m) => {
      const gap = gapOf(m)
      return {
        who: m.name,
        cwd: m.cwd,
        doneWhen: m.doneWhen!,
        ...(m.report ? { report: m.report } : {}),
        proven: !gap,
        ...(gap ? { gap } : {})
      }
    })

  // The lead's own worktree is where integration commits land, so anything it owns counts as granted
  // too; in a one-member team that is the whole diff.
  const granted = [...crew.flatMap((m) => m.owns ?? []), ...(lead?.owns ?? [])]

  const flags: FileFlag[] = []
  for (const f of r.files) {
    const outside = granted.length > 0 && !ownedBy(f, granted)
    const excluded = excludedBy(f, s.charter?.wontTouch)
    const rule = RISKS.find((x) => x.hit(norm(f)))
    if (excluded || outside || rule) flags.push({ path: f, outside, ...(excluded ? { excluded } : {}), ...(rule ? { why: rule.why } : {}) })
  }
  // what the user ruled out comes first, then reaching outside the brief; a sensitive file somebody owns is a note
  flags.sort((a, b) => Number(!!b.excluded) - Number(!!a.excluded) || Number(b.outside) - Number(a.outside))

  const blocked = flags.some((f) => f.excluded)
  return { flags, claims, blocked, clean: !blocked && !flags.some((f) => f.outside) && claims.every((c) => c.proven) }
}

export interface Stall {
  who: string
  consoleId: string
  minutes: number
}

/**
 * Members that have been going a long time without reporting.
 *
 * ponytail: measured from createdAt, because FleetMember records no last-activity time — so a
 * genuinely long task trips this as readily as a wedged one. That is why it only ever annotates,
 * never blocks. To make it mean "idle" rather than "old", stamp a lastActivityAt on the member when
 * its console produces output and measure from that instead.
 */
export function stalled(s: FleetState, now: number, afterMinutes = 45): Stall[] {
  return Object.values(s.members)
    .filter((m) => (m.status === 'working' || m.status === 'starting') && !m.report)
    .map((m) => ({ who: m.name, consoleId: m.id, minutes: Math.round((now - m.createdAt) / 60000) }))
    .filter((x) => x.minutes >= afterMinutes)
    .sort((a, b) => b.minutes - a.minutes)
}
