// Lead/worker teams: shared shapes between the fleet core (main) and the board (renderer).

import type { Charter } from './charter'
import type { DoneWhenCheck, LiveDiff } from './live'

export type FleetRole = 'lead' | 'worker' | 'reviewer'

export interface FleetMember {
  /** console (board node) id */
  id: string
  role: FleetRole
  name: string
  agentId: string
  projectId: string
  /** the lead this member reports to (workers, reviewers) */
  leadId?: string
  task?: string
  owns?: string[]
  doneWhen?: string
  /** working directory; a git worktree for leads and workers */
  cwd: string
  branch?: string
  status: 'starting' | 'working' | 'reported' | 'merged' | 'closed'
  report?: string
  createdAt: number
  /** when its console last printed anything, stamped coarsely (main/live.ts): silence is what a stall is */
  lastOutputAt?: number
  /** a worker's uncommitted work in its worktree, sampled while it works (main/live.ts) */
  diff?: LiveDiff
  /** a Lead's: the commit its integration branch started from, what Ready's counts and fleet:diff are measured against */
  base?: string
}

export interface FleetTask {
  id: string
  title: string
  owner?: string
  status: 'todo' | 'doing' | 'review' | 'done' | 'blocked'
  note?: string
  /** first taken up (live.stampTask) */
  startedAt?: number
  /** handed in or stuck; cleared if it goes back to doing */
  endedAt?: number
  /** minutes the Lead expected it to take, from fleet_plan */
  estimate?: number
}

export interface FleetMessage {
  id: string
  from: string
  to: string
  kind: 'goal' | 'brief' | 'message' | 'report' | 'answer' | 'system'
  text: string
  at: number
  delivered: boolean
}

export interface FleetAsk {
  id: string
  from: string
  question: string
  options: string[]
  /** one short trade-off per option (same order), when the lead gave them */
  notes?: string[]
  /** the option the lead would pick */
  recommended?: number
  at: number
  answer?: string
}

export interface FleetReady {
  leadId: string
  branch: string
  summary: string
  commits: number
  files: string[]
  /** the commit the card describes, and the one Merge merges: the Lead stays on and may commit again */
  head?: string
  /** lines added / removed per file */
  stat?: { path: string; add: number; del: number }[]
  /** what the lead checked before finishing ("typecheck and 48 tests pass"), in its words */
  verified?: string
  at: number
  /** the repo has an origin remote, so the branch can become a pull request */
  hasRemote?: boolean
  /** set once the user opened a PR from the Ready card */
  prUrl?: string
}

export interface FleetState {
  projectId: string
  projectPath: string
  members: Record<string, FleetMember>
  tasks: FleetTask[]
  messages: FleetMessage[]
  asks: FleetAsk[]
  ready: FleetReady | null
  /** what the current job was agreed to be; absent on a board saved before charters, or one started without */
  charter?: Charter
  /** the charter's done-when, run in the Lead's worktree as the work lands: progress, not part of what was agreed */
  check?: DoneWhenCheck
  /** where the project sits inside its repo (`apps/web/`), when it is opened at a sub-folder */
  repoPrefix?: string
}

/**
 * Folders a worktree gets as links to the user's checkout, so a worker has the installed dependencies
 * without a copy. Only node_modules: npm replaces the link rather than writing through it, where pip
 * would install into the user's own .venv and outlive the team.
 */
export const LINKED_DIRS = ['node_modules'] as const

/**
 * Dependency folders that are never a worker's work, so staging and the live diff leave them out by
 * name: a folder-only gitignore pattern (`node_modules/`) does not match a link. Left out only while
 * the repo tracks nothing under them, so a committed Go or PHP vendor/ is still saved.
 */
export const HEAVY_DIRS = ['node_modules', '.venv', 'venv', 'vendor'] as const

export const emptyFleet = (projectId: string, projectPath: string): FleetState => ({
  projectId,
  projectPath,
  members: {},
  tasks: [],
  messages: [],
  asks: [],
  ready: null
})
