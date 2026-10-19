// Lead/worker teams: shared shapes between the fleet core (main) and the board (renderer).

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
}

export interface FleetTask {
  id: string
  title: string
  owner?: string
  status: 'todo' | 'doing' | 'review' | 'done' | 'blocked'
  note?: string
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
}

export const emptyFleet = (projectId: string, projectPath: string): FleetState => ({
  projectId,
  projectPath,
  members: {},
  tasks: [],
  messages: [],
  asks: [],
  ready: null
})
