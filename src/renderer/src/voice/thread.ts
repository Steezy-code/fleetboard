import { create } from 'zustand'
import { uid } from '../lib/api'
import { useApp } from '../state/store'
import type { Action } from './actions'

// Two small stores for the voice area:
//  - useThread: every command, plan and reply (persisted to project extras 'thread', last 100)
//  - useVoice: live state of the bar (listening, level meter, caption, pending confirmation, ...)

export type ThreadKind = 'user' | 'system' | 'plan' | 'error'

export interface ThreadEntry {
  id: string
  at: number
  kind: ThreadKind
  text: string
  source?: 'voice' | 'typed'
}

interface ThreadState {
  projectId: string | null
  entries: ThreadEntry[]
  add: (kind: ThreadKind, text: string, source?: ThreadEntry['source']) => ThreadEntry
  clear: () => void
}

const MAX = 100

export const useThread = create<ThreadState>((set, get) => ({
  projectId: null,
  entries: [],
  add: (kind, text, source) => {
    const e: ThreadEntry = { id: uid('th'), at: Date.now(), kind, text, source }
    const entries = [...get().entries, e].slice(-MAX)
    set({ entries })
    persist(entries)
    return e
  },
  clear: () => {
    set({ entries: [] })
    persist([])
  }
}))

let persistTimer: number | undefined
function persist(entries: ThreadEntry[]) {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    if (useApp.getState().project) useApp.getState().setProjectExtra('thread', entries.slice(-MAX))
  }, 400)
}

/** Load the thread of the open project (called whenever the project changes). */
export function hydrateThread() {
  const p = useApp.getState().project
  const id = p?.id ?? null
  if (useThread.getState().projectId === id) return
  window.clearTimeout(persistTimer)
  const saved = (p?.extras.thread as ThreadEntry[] | undefined) ?? []
  useThread.setState({ projectId: id, entries: Array.isArray(saved) ? saved.slice(-MAX) : [] })
}

export const say = (text: string) => useThread.getState().add('system', text)

// ---------------------------------------------------------------- live voice state

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking'

export interface PendingPlan {
  id: string
  actions: Action[]
  /** human-readable steps shown in the caption */
  steps: string[]
  /** the spoken / shown question */
  prompt: string
  /** reply to speak after running */
  say?: string
  /** the project it is about, and when it was asked: it does not carry over to another, or go stale */
  projectId: string
  /** the workspace in front of the user when it was asked: its steps are pinned to what was there */
  workspaceId?: string
  at: number
}

export interface ModelLoad {
  what: 'speech' | 'voice'
  /** 0-100, or null while the size is unknown */
  pct: number | null
  label: string
}

interface VoiceState {
  phase: VoicePhase
  speaking: boolean
  /** mic RMS, 0..1 */
  level: number
  /** Measured synthesized speech RMS; null when using the system voice. */
  outputLevel: number | null
  /** live / final transcript shown in the caption */
  transcript: string
  /** last system reply shown in the caption */
  reply: string
  /** caption visible until (ms timestamp); 0 = hidden unless pending/listening */
  captionUntil: number
  pending: PendingPlan | null
  download: ModelLoad | null
  /** cancels the running planner call */
  cancelThinking: (() => void) | null
  /**
   * The Inbox card in front when push-to-talk began: a spoken "allow" is about that card, and only
   * answers it if it is still the one in front once the words are transcribed (planner runCommand)
   */
  heardFront: string | null
}

export const useVoice = create<VoiceState>(() => ({
  phase: 'idle',
  speaking: false,
  level: 0,
  outputLevel: null,
  transcript: '',
  reply: '',
  captionUntil: 0,
  pending: null,
  download: null,
  cancelThinking: null,
  heardFront: null
}))

export const setVoice = (patch: Partial<VoiceState>) => useVoice.setState(patch)

/** Show a reply in the caption for a few seconds. */
export function showReply(text: string, ms = 6000) {
  setVoice({ reply: text, captionUntil: Date.now() + ms })
}
