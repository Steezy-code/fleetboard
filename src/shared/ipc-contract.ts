import type { FleetReady } from './fleet'
import type { Project, Settings, PtySpawnRequest, PtyInfo, CliRunRequest, AgentAvailability } from './types'
import type { PromptAnswer, AnswerResult, Prompt } from './prompt'
import type { BoardPreview, SnapshotInfo } from './recovery'

/** Typed contracts for state, process control and recovery. Legacy channels migrate here incrementally. */
export interface IpcContract {
  'fleet:verifyReady': { args: [projectId: string, head: string]; result: NonNullable<FleetReady['evidence']> }
  'agents:detect': { args: [force?: boolean]; result: AgentAvailability[] }
  'store:settings': { args: []; result: Settings }
  'store:setSettings': { args: [patch: Partial<Settings>]; result: Settings }
  'store:projectId': { args: [path: string]; result: string }
  'store:loadProject': { args: [id: string]; result: Project | null }
  'store:saveProject': { args: [project: Project]; result: void }
  'pty:spawn': { args: [request: PtySpawnRequest]; result: PtyInfo }
  'pty:list': { args: []; result: PtyInfo[] }
  'pty:info': { args: [id: string]; result: PtyInfo | null }
  'pty:buffer': { args: [id: string]; result: string | null }
  'pty:tail': { args: [id: string, chars?: number]; result: string }
  'pty:prompt': { args: [id: string]; result: Prompt | null }
  'pty:answer': { args: [id: string, answer: PromptAnswer]; result: AnswerResult }
  'pty:kill': { args: [id: string]; result: unknown }
  'pty:pause': { args: [id: string]; result: unknown }
  'pty:resume': { args: [id: string]; result: unknown }
  'cli:run': { args: [request: CliRunRequest]; result: { code: number; text: string } }
  'cli:cancel': { args: [id: string]; result: void }
  'goal:check': { args: [cwd: string, command: string]; result: { code: number | null; tail: string; error?: string; timedOut?: boolean } }
  'recovery:list': { args: []; result: SnapshotInfo[] }
  'recovery:preview': { args: [id: string]; result: BoardPreview }
  'recovery:import': { args: []; result: BoardPreview | null }
  'recovery:export': { args: []; result: string | null }
  'recovery:apply': { args: [token: string]; result: Project }
}
