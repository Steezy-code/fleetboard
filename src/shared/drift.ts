// Oracle's ambient line: one quiet sentence when live work drifts from its charter, and nothing the
// rest of the time. Drift against the charter is the trigger — the check going the wrong way, a member
// gone quiet, a task far past its estimate — never a model deciding something seems interesting, and
// the sentence is built here from the trigger's own fields: a model asked to phrase it on a timer
// would spend the user's tokens to say what the numbers already say.
//
// Silence is the design problem: a line that appears constantly is worse than none. So there is at
// most one, only while a Lead is working, and a dismissed one stays dismissed until something new
// happens (output then fresh silence, a new run, a new task).

import type { FleetMember, FleetState } from './fleet'
import { QUIET_MINUTES, stalled } from './mergeReview'
import { farOver, minutes, span } from './live'

export interface Drift {
  /** names this occurrence: dismissing it hides this one, not the next */
  key: string
  kind: 'check' | 'silent' | 'over'
  who?: string
  /** the console to open */
  consoleId?: string
  text: string
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** The Lead the live work belongs to, while it works. One team at a time, so the newest. */
const workingLead = (s: FleetState): FleetMember | undefined =>
  Object.values(s.members)
    .filter((m) => m.role === 'lead' && m.status !== 'closed')
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((m) => m.status === 'working')

function checkDrift(s: FleetState, lead: FleetMember): Drift | null {
  const cmd = s.charter?.doneWhen
  if (!cmd || !s.check || s.check.off || s.check.command !== cmd) return null
  // runs that answered: a timeout or a run that could not start says nothing about the direction
  const done = s.check.runs.filter((r) => r.code !== null)
  const last = done[done.length - 1]
  const prev = done[done.length - 2]
  if (!last || !prev) return null
  const c = `\`${clip(cmd, 40)}\``
  const base = { key: `check:${last.at}`, kind: 'check' as const, who: lead.name, consoleId: lead.id }
  if (prev.code === 0 && last.code !== 0) return { ...base, text: `${c} passed on its last run and fails now${last.failing ? ` (${last.failing} failing)` : ''}.` }
  if (prev.failing !== undefined && last.failing !== undefined && last.failing > prev.failing)
    return { ...base, text: `${c} went from ${prev.failing} failing to ${last.failing} since its last run.` }
  return null
}

/** Members gone quiet, quietest first: the same members, by the same threshold, as the Inbox's stall card. */
function silentDrifts(s: FleetState, now: number): Drift[] {
  return stalled(s, now, QUIET_MINUTES).map((x) => {
    const m = s.members[x.consoleId]
    const task = s.tasks.find((t) => t.owner === x.consoleId && t.status === 'doing')
    return {
      key: `silent:${x.consoleId}:${m?.lastOutputAt ?? m?.createdAt ?? 0}`,
      kind: 'silent' as const,
      who: x.who,
      consoleId: x.consoleId,
      text: `${x.who} has been silent for ${span(x.minutes)}${task ? ` on “${clip(task.title, 50)}”` : ''}.`
    }
  })
}

/** Tasks, then the job, far past what they were expected to take. */
function overDrifts(s: FleetState, lead: FleetMember, now: number): Drift[] {
  const out: Drift[] = s.tasks
    .filter((t) => t.status === 'doing' && farOver(t, now))
    .map((t) => {
      const m = t.owner ? s.members[t.owner] : undefined
      return {
        key: `over:${t.id}`,
        kind: 'over' as const,
        ...(m ? { who: m.name, consoleId: m.id } : {}),
        text: `${m?.name ?? 'The team'} is at ${span(minutes(now - t.startedAt!))} on “${clip(t.title, 50)}”, est ${span(t.estimate!)}.`
      }
    })
  const job = { startedAt: lead.createdAt, estimate: s.charter?.estimate }
  if (!s.ready && farOver(job, now))
    out.push({ key: `over:job:${lead.id}`, kind: 'over', who: lead.name, consoleId: lead.id, text: `The team is at ${span(minutes(now - lead.createdAt))} on this job, est ${span(job.estimate!)}.` })
  return out
}

/**
 * The one drift worth a line, or null — which is the answer almost all of the time. Heaviest first:
 * the charter's own check getting worse, then a member gone quiet, then a task far past its estimate.
 * `live`: whether a console is running (a Lead whose console is gone is not working, whatever the
 * state says).
 */
export function driftOf(s: FleetState | null, now: number, o: { live?: (id: string) => boolean; dismissed?: Set<string> } = {}): Drift | null {
  if (!s) return null
  const lead = workingLead(s)
  if (!lead || o.live?.(lead.id) === false) return null
  const check = checkDrift(s, lead)
  const all = [...(check ? [check] : []), ...silentDrifts(s, now), ...overDrifts(s, lead, now)]
  return all.find((d) => !o.dismissed?.has(d.key)) ?? null
}
