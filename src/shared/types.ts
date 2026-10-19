// Data model shared by the main process and the renderer.
// Everything here is persisted as JSON under ~/.fleetboard/.

export const SCHEMA_VERSION = 1

export type NodeType =
  | 'console'
  | 'web'
  | 'kanban'
  | 'calendar'
  | 'note'
  | 'text'
  | 'checklist'
  | 'image'
  | 'git'
  | 'file'
  | 'doc'
  | 'orchestrator'
  | 'plan'

export interface BoardNode<D = any> {
  id: string
  type: NodeType
  x: number
  y: number
  w: number
  h: number
  z: number
  title?: string
  groupId?: string
  data: D
}

export type Role =
  | 'Frontend'
  | 'Backend'
  | 'Testers'
  | 'Reviewers'
  | 'Design'
  | 'Docs'
  | 'Security'
  | 'General'

export const ROLES: Role[] = ['Frontend', 'Backend', 'Testers', 'Reviewers', 'Design', 'Docs', 'Security', 'General']

export const ROLE_TINT: Record<Role, string> = {
  Frontend: '#ff7a45',
  Backend: '#ff4a2b',
  Testers: '#3ecf8e',
  Reviewers: '#f5b740',
  Design: '#c084fc',
  Docs: '#60a5fa',
  Security: '#f43f5e',
  General: '#a8a29e'
}

export interface Group {
  id: string
  name: string
  role: Role
  x: number
  y: number
  w: number
  h: number
  collapsed?: boolean
}

/** A connection between two board items (node or group ids). Used for orchestrator wires. */
export interface Wire {
  id: string
  from: string
  to: string
}

export type InkKind = 'path' | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'label'

export interface InkItem {
  id: string
  kind: InkKind
  /** world-space points for path/line/arrow */
  points?: [number, number][]
  x: number
  y: number
  w: number
  h: number
  stroke: string
  fill?: string
  width: number
  opacity?: number
  dashed?: boolean
  sloppy?: boolean
  rounded?: boolean
  text?: string
  fontSize?: number
  /** ink drawn by the diagram studio carries the figure it belongs to */
  figureId?: string
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Workspace {
  id: string
  name: string
  nodes: BoardNode[]
  groups: Group[]
  wires: Wire[]
  ink: InkItem[]
  camera: Camera
  /** free-form per-workspace state owned by feature modules */
  extras: Record<string, any>
}

export interface Project {
  schema: number
  id: string
  name: string
  path: string
  workspaces: Workspace[]
  activeWorkspaceId: string
  lastOpened: number
  /** free-form per-project state owned by feature modules (loops, memory, ...) */
  extras: Record<string, any>
}

export interface ProjectMeta {
  id: string
  name: string
  path: string
  lastOpened: number
  consoles: number
}

export type ConsoleStatus = 'starting' | 'working' | 'idle' | 'needs-you' | 'done' | 'paused' | 'exited'

export interface ConsoleData {
  agentId: string
  name: string
  cwd: string
  profileId?: string
  autoApprove?: boolean
  /** auto-accept file edits but keep asking before commands (agents with editsArgs) */
  acceptEdits?: boolean
  extraArgs?: string[]
  /** true while the console had a live process when the board was last saved */
  wasRunning?: boolean
  /** how the next launch should start: fresh session or the CLI's native resume */
  launch?: 'fresh' | 'resume' | 'ask'
  /** this console's conversation, for CLIs that take one (AgentDef.session): what a resume picks up */
  sessionId?: string
  createdAt: number
}

export interface AgentDef {
  id: string
  name: string
  bin: string
  args?: string[]
  color: string
  vendor: string
  resumeArgs?: string[]
  /** start a conversation under a given id / resume that conversation (instead of "the latest") */
  session?: { start: (id: string) => string[]; resume: (id: string) => string[] }
  yoloArgs?: string[]
  /** middle permission level: file edits are auto-accepted, commands still ask */
  editsArgs?: string[]
  /** env var the CLI reads to move its config dir (enables profiles) */
  configEnv?: string
  /** supports headless one-shot prompts */
  headless?: (prompt: string) => string[]
  homepage?: string
  install?: string
}

export interface AgentAvailability {
  id: string
  path: string | null
  version?: string
}

export interface PtySpawnRequest {
  id: string
  agentId: string
  cwd: string
  cols: number
  rows: number
  resume?: boolean
  /** the conversation this console had, to resume (AgentDef.session) */
  sessionId?: string
  autoApprove?: boolean
  /** auto-accept file edits but keep asking before commands (agents with editsArgs) */
  acceptEdits?: boolean
  profileId?: string
  extraArgs?: string[]
  /** shell command used by the custom agent */
  command?: string
}

export interface PtyInfo {
  id: string
  pid: number
  agentId: string
  status: ConsoleStatus
  startedAt: number
  /** the conversation id the CLI runs under, when known */
  sessionId?: string
}

export interface Settings {
  autoApprove: boolean
  plannerAgent: string
  speakReplies: boolean
  voiceName: string
  sttModel: string
  pushToTalkKey: 'Space' | 'AltSpace'
  defaultAgent: string
  fontSize: number
  confirmKill: boolean
  /** cad: wheel zooms at the cursor, middle-drag pans, left-drag selects (AutoCAD). trackpad: wheel pans, drag pans */
  navigation: 'cad' | 'trackpad'
  showMinimap: boolean
  /** Helm: the command bar reads the whole board and suggests the best route (playbook, team, message, actions) */
  helm: boolean
  names: string[]
  customAgents: AgentDef[]
}

export const DEFAULT_SETTINGS: Settings = {
  autoApprove: false,
  plannerAgent: 'claude',
  speakReplies: true,
  voiceName: 'af_heart',
  sttModel: 'onnx-community/whisper-base.en',
  pushToTalkKey: 'Space',
  defaultAgent: 'claude',
  fontSize: 12,
  confirmKill: true,
  navigation: 'cad',
  showMinimap: true,
  helm: true,
  names: [
    'Maya', 'Rafa', 'Iris', 'Zoe', 'Leo', 'Nova', 'Kai', 'Otto', 'Ada', 'Bex', 'Cy', 'Pip', 'Dax', 'Ren', 'Juno',
    'Milo', 'Ivy', 'Eli', 'Sol', 'Tess', 'Finn', 'Lux', 'Wren', 'Ash'
  ],
  customAgents: []
}

export interface CliRunRequest {
  runId: string
  agentId?: string
  prompt: string
  cwd: string
  model?: string
  profileId?: string
  /** allow file edits / tools (default: read-only plan mode where supported) */
  allowTools?: boolean
}

export interface MemoryCard {
  id: string
  scope: 'repo' | 'global'
  repoPath?: string
  category: 'Context' | 'Architecture' | 'Structure' | 'Commands' | 'Conventions' | 'Gotchas'
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export interface Profile {
  id: string
  agentId: string
  name: string
  dir: string
  createdAt: number
}

/** A state file that could not be read at startup or when a project opened (see src/main/store.ts). */
export interface Recovery {
  /** what could not be read: 'app' (settings and project list) or a project id */
  what: string
  /** where the unreadable file was moved, kept for rescue by hand */
  corruptCopy: string
  /** the history/ snapshot used instead, if there was one */
  snapshot?: string
}
