import type { FleetReady } from './fleet'
import type { Project, Settings, PtySpawnRequest, PtyInfo, CliRunRequest, AgentAvailability, FileStat, TreeEntry, WriteResult } from './types'
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
  'fs:read': { args: [file: string]; result: string }
  'fs:write': { args: [file: string, content: string, opts?: { base?: string | null }]; result: WriteResult }
  'fs:writeBase64': { args: [file: string, base64: string]; result: void }
  'fs:exists': { args: [path: string]; result: boolean }
  'fs:mkdir': { args: [path: string]; result: unknown }
  'fs:stat': { args: [path: string]; result: FileStat | null }
  'fs:tree': { args: [dir: string, depth?: number, ext?: string[]]; result: TreeEntry[] }
  'fleet:runCheck': { args: [projectId: string]; result: boolean }
  'pty:ruleFingerprint': { args: [id: string]; result: string | null }
  'pty:answerByRule': { args: [id: string, answer: PromptAnswer, command: string, who: string, fingerprint: string]; result: AnswerResult }
  'pdf:fromHtml': { args: [html: string, outPath: string]; result: string }
}

/**
 * Channels from before the typed contract, still reached through invoke<T>(). Frozen: a new channel
 * goes into IpcContract (test/unit/ipc-contract.test.ts holds both to it), and one that moves there
 * comes off this list.
 */
export const UNTYPED_CHANNELS: readonly string[] = [
  'app:crashRecovered',
  'app:idleSeconds',
  'app:paths',
  'app:quit',
  'ci:failedLog',
  'ci:prFeedback',
  'ci:status',
  'dialog:openFile',
  'dialog:openFolder',
  'dialog:saveFile',
  'fleet:ack',
  'fleet:answer',
  'fleet:checkOff',
  'fleet:diff',
  'fleet:discard',
  'fleet:done',
  'fleet:fromGitHub',
  'fleet:isolation',
  'fleet:mergeReady',
  'fleet:openPr',
  'fleet:revertMerge',
  'fleet:startLead',
  'fleet:state',
  'fleet:userMessage',
  'fs:writeBase64',
  'git:branches',
  'git:checkout',
  'git:commit',
  'git:diff',
  'git:fetch',
  'git:init',
  'git:isRepo',
  'git:log',
  'git:prList',
  'git:pull',
  'git:push',
  'git:remote',
  'git:show',
  'git:status',
  'journal:append',
  'journal:dir',
  'journal:read',
  'knowledge:read',
  'profiles:create',
  'profiles:default',
  'profiles:delete',
  'profiles:list',
  'profiles:open',
  'profiles:rename',
  'profiles:saveCurrent',
  'pty:deliver',
  'remote:disable',
  'remote:enable',
  'remote:reset',
  'remote:status',
  'shell:openExternal',
  'shell:openPath',
  'shell:showItem',
  'skills:create',
  'skills:delete',
  'skills:list',
  'skills:open',
  'skills:read',
  'skills:save',
  'starter:goals',
  'store:forgetProject',
  'store:getGlobal',
  'store:projects',
  'store:recoveries',
  'store:setGlobal',
  'sweep:last',
  'sweep:repos',
  'sweep:run',
  'update:check',
  'usage:limits',
  'usage:spentIn',
  'usage:tokens',
  'webview:devtools',
  'win:close',
  'win:maximize',
  'win:minimize'
]
