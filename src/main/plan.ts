import type { FleetTask } from '@shared/fleet'

// Linking a worker to the task it does on the Lead's plan, so the board shows who does what. Leads
// refer to tasks by id, by their number in the plan, or by (roughly) their title, and sometimes not at
// all; a wrong link is worse than none, so guessing only links a clear, unique match.

const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const norm = (t: string) => words(t).join(' ')

/** The plan task `ref` names: its id, its number in the plan ("2", "#2", "task 2") or its title. */
export function findTask(tasks: FleetTask[], ref: unknown): FleetTask | undefined {
  const r = String(ref ?? '').trim()
  if (!r) return undefined
  const byId = tasks.find((t) => t.id === r)
  if (byId) return byId
  const n = /^(?:task\s*)?#?(\d+)\.?$/i.exec(r)
  if (n) return tasks[Number(n[1]) - 1]
  const title = tasks.filter((t) => norm(t.title) === norm(r))
  return title.length === 1 ? title[0] : undefined
}

const STOP = new Set(['the', 'and', 'for', 'with', 'into', 'that', 'this', 'from', 'add', 'make', 'write', 'update', 'create', 'implement'])
const significant = (t: string) => new Set(words(t).filter((w) => w.length >= 3 && !STOP.has(w)))

/**
 * The open plan task a new worker's assignment is about, when the Lead did not say: the one task
 * most of whose significant title words appear in the assignment, and clearly more than any other.
 */
export function guessTask(tasks: FleetTask[], assignment: string): FleetTask | undefined {
  const open = tasks.filter((t) => !t.owner && t.status === 'todo')
  const exact = open.filter((t) => norm(t.title) === norm(assignment))
  if (exact.length === 1) return exact[0]
  const said = significant(assignment)
  const scored = open
    .map((t) => {
      const title = significant(t.title)
      const hits = [...title].filter((w) => said.has(w)).length
      return { t, score: title.size ? hits / title.size : 0 }
    })
    .sort((a, b) => b.score - a.score)
  const [best, next] = scored
  if (!best || best.score < 0.6) return undefined
  if (next && best.score - next.score < 0.25) return undefined
  return best.t
}
