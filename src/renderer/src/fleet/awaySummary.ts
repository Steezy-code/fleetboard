import type { FleetState } from '@shared/fleet'

// What happened while you were away, in a handful of lines: the card on top of the Inbox when you
// come back (away.ts). Read from the Night log (main/journal.ts) and the team's own record, so it
// says only what was recorded — finished work and questions first, then what was decided for you,
// then the background noise. The full night is one click further, in the Night log drawer.

export interface JournalLine {
  at: number
  kind: string
  text: string
  project?: string
  detail?: Record<string, unknown>
}

const MAX_LINES = 6
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "Ava done, Rafa blocked", from reports that start "(done) …" (main/fleet.ts fleet_report) */
function reported(fleet: FleetState, since: number): string | null {
  const reports = fleet.messages.filter((m) => m.kind === 'report' && m.at >= since)
  if (!reports.length) return null
  const last = new Map<string, string>()
  for (const r of reports) last.set(fleet.members[r.from]?.name ?? 'a worker', /^\((\w+)\)/.exec(r.text)?.[1] ?? 'reported')
  return `${plural(reports.length, 'report')} to the Lead: ${[...last].map(([who, how]) => `${who} ${how}`).join(', ')}`
}

/** "3 by your team rules, 1 from your phone" */
function answeredBy(entries: JournalLine[]): string | null {
  const answers = entries.filter((e) => e.kind === 'prompt.answer' && e.detail?.by !== 'you, on the board')
  if (!answers.length) return null
  const by = new Map<string, number>()
  for (const e of answers) {
    const who = e.detail?.by === 'rule' ? 'by your team rules' : e.detail?.by === 'your phone' ? 'from your phone' : 'by Fleetboard'
    by.set(who, (by.get(who) ?? 0) + 1)
  }
  return `${plural(answers.length, 'prompt')} answered for you: ${[...by].map(([who, n]) => `${n} ${who}`).join(', ')}`
}

export function awaySummary({ since, entries, fleet }: { since: number; entries: JournalLine[]; fleet: FleetState | null | undefined }): string[] {
  const lines: string[] = []
  const after = entries.filter((e) => e.at >= since)
  const of = (kind: string) => after.filter((e) => e.kind === kind)
  const name = (id: string) => fleet?.members[id]?.name ?? 'The Lead'

  if (fleet?.ready && fleet.ready.at >= since) lines.push(`${name(fleet.ready.leadId)} finished the goal; it is ready to merge`)
  for (const e of of('fleet.merge')) lines.push(e.text.replace(/^the /, 'The '))
  const asks = fleet?.asks.filter((a) => !a.answer && a.at >= since) ?? []
  if (asks.length) lines.push(`${name(asks[0]!.from)} has ${plural(asks.length, 'question')} for you`)
  const reports = fleet ? reported(fleet, since) : null
  if (reports) lines.push(reports)
  const answers = answeredBy(after)
  if (answers) lines.push(answers)
  for (const e of of('guard.ceiling')) lines.push(e.text)
  const fires = of('loop.fire').length
  const ends = of('loop.end').length
  if (fires || ends) lines.push([fires ? `Loops sent ${plural(fires, 'instruction')}` : '', ends ? `${plural(ends, 'loop')} finished` : ''].filter(Boolean).join('; '))
  const crashed = of('console.exit').filter((e) => typeof e.detail?.code === 'number' && e.detail.code !== 0).length
  if (crashed) lines.push(`${plural(crashed, 'console')} ended with an error`)

  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${plural(lines.length - MAX_LINES + 1, 'more thing')} in the Night log`] : lines
}

/** "47 min", "2 h 5 min" */
export function spanMs(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(m / 60)
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
}
