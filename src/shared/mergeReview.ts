// What the team actually did, held against what it was told to do — read just before the user merges.
//
// Everything here is derived from fleet state alone: at fleet_finish the crew is still in
// s.members (dismissTeam only runs once the user merges), so each worker's owns/doneWhen/report
// are all still there to check the lead's Ready card against.

import type { FleetMember, FleetReady, FleetState } from './fleet'

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
  reportedAndMerged: boolean
  /** why the worker has not both reported and been merged */
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
  /** nothing is blocked, every file in the diff was inside someone's owns, and every worker has reported and been merged */
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

/** A glob as a regex: `*` and `?` stay inside one folder, `**` crosses folders. */
const globRe = (o: string) =>
  o
    .split(/(\*\*\/|\/\*\*$|\*\*|\*|\?)/)
    .map((t) =>
      t === '**/' ? '(?:.*/)?' : t === '/**' ? '(?:/.*)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    )
    .join('')

/**
 * Does one entry cover `f` (already `norm`ed)? A plain entry is the file itself or a folder holding
 * it, from the repo root. An entry with a wildcard is a glob, matched the way .gitignore does: from
 * the root when it has a slash, at any depth when it has none (`*.lock`), and a folder it matches
 * covers what is inside. Case is ignored: on Windows and macOS `Docs` and `docs` are one folder.
 */
const covers = (f: string, raw: string): boolean => {
  // a leading slash anchors at the root, as in .gitignore, which an entry is anyway
  const o = norm(norm(raw).replace(/^\/+/, '')).toLowerCase()
  if (!o) return false
  const file = f.toLowerCase()
  if (!/[*?]/.test(o)) return file === o || file.startsWith(`${o}/`)
  return new RegExp(`^${o.includes('/') ? '' : '(?:.*/)?'}${globRe(o)}(?:/.*)?$`).test(file)
}

/** Is `file` inside one of `owns`? */
export function ownedBy(file: string, owns: string[] | undefined): boolean {
  const f = norm(file)
  return (owns ?? []).some((raw) => covers(f, raw))
}

/**
 * An exclusion `covers` may match, or null for one that must not be used at all: a pattern of
 * wildcards alone (`*`, `**\/*`) would refuse every merge over a rule the user never saw as
 * "everything". Normed twice: stripping the leading slash can uncover a `./` (`/./*`).
 */
const asExclusion = (raw: string): string | null => {
  const o = norm(norm(raw).replace(/^\/+/, ''))
  return o && !/^[*/?]+$/.test(o) ? o : null
}

/**
 * Whether the merge gate can hold anyone to this exclusion. A description ("the auth module")
 * matches no path, so the card says it is not enforced rather than promising what nothing checks.
 */
export const enforceable = (raw: string): boolean => {
  const o = asExclusion(raw)
  return o !== null && !(/\s/.test(o) && !/[/.*?]/.test(o))
}

/**
 * The `wontTouch` entry that covers `file`, as it was written, or null. git names files from the
 * repo root; a project opened at a sub-folder (`prefix`) may have its rules written from there, so
 * an entry matching either way counts.
 */
export function excludedBy(file: string, wontTouch: string[] | undefined, prefix = ''): string | null {
  const f = norm(file)
  const p = norm(prefix)
  const inProject = p && f.startsWith(`${p}/`) ? f.slice(p.length + 1) : null
  return (
    (wontTouch ?? []).find((raw) => {
      const o = asExclusion(raw)
      return o !== null && (covers(f, o) || (inProject !== null && covers(inProject, o)))
    }) ?? null
  )
}

const gapOf = (m: FleetMember): Claim['gap'] | undefined => {
  if (m.status === 'merged') return m.report ? undefined : 'never reported'
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
        reportedAndMerged: !gap,
        ...(gap ? { gap } : {})
      }
    })

  // The lead's own worktree is where integration commits land, so anything it owns counts as granted
  // too; in a one-member team that is the whole diff.
  const granted = [...crew.flatMap((m) => m.owns ?? []), ...(lead?.owns ?? [])]

  const flags: FileFlag[] = []
  for (const f of r.files) {
    const outside = granted.length > 0 && !ownedBy(f, granted)
    const excluded = excludedBy(f, s.charter?.wontTouch, s.repoPrefix)
    const rule = RISKS.find((x) => x.hit(norm(f)))
    if (excluded || outside || rule) flags.push({ path: f, outside, ...(excluded ? { excluded } : {}), ...(rule ? { why: rule.why } : {}) })
  }
  // what the user ruled out comes first, then reaching outside the brief; a sensitive file somebody owns is a note
  flags.sort((a, b) => Number(!!b.excluded) - Number(!!a.excluded) || Number(b.outside) - Number(a.outside))

  const blocked = flags.some((f) => f.excluded)
  return { flags, claims, blocked, clean: !blocked && !flags.some((f) => f.outside) && claims.every((c) => c.reportedAndMerged) }
}

/**
 * Nothing to merge into the checkout: no branch, no commits, or the work went to a pull request
 * instead. The Ready card then offers Done rather than Merge, on the board and on the phone.
 */
export const closeOnly = (r: Pick<FleetReady, 'branch' | 'commits' | 'prUrl'>) => !r.branch || r.commits === 0 || !!r.prUrl

export interface Stall {
  who: string
  consoleId: string
  /** minutes its console has printed nothing */
  minutes: number
}

/**
 * Silence that makes a member stalled: Claude Code, Codex and Gemini all redraw while they work, a
 * tool call in flight included, so a console this quiet is waiting on something or stuck. One
 * threshold for the Inbox card and the ambient line (drift.ts), so they cannot disagree.
 */
export const QUIET_MINUTES = 5

/**
 * Members still going that have gone quiet, quietest first. Measured from the last output the main
 * process saw (`lastOutputAt`, which it restarts when it starts watching: see live.watchFrom), never
 * from the estimate: this is what works on the first goal in a fresh repo, where nothing estimated
 * anything.
 */
export function stalled(s: FleetState, now: number, quietMinutes = QUIET_MINUTES): Stall[] {
  return Object.values(s.members)
    .filter((m) => (m.status === 'working' || m.status === 'starting') && !m.report)
    .map((m) => ({ who: m.name, consoleId: m.id, minutes: Math.floor((now - (m.lastOutputAt ?? m.createdAt)) / 60000) }))
    .filter((x) => x.minutes >= quietMinutes)
    .sort((a, b) => b.minutes - a.minutes)
}

/** Only a successful, stable check of the offered commit verifies a Ready card. */
export function verificationOf(r: FleetReady): 'passed' | 'failed' | 'stale' | 'unobserved' {
  const e = r.evidence
  if (!e) return 'unobserved'
  if (!r.head || e.run.head !== r.head || e.run.stable !== true) return 'stale'
  return e.run.code === 0 && !e.run.timedOut && !e.run.error && !e.run.failing ? 'passed' : 'failed'
}
