import { create } from 'zustand'
import { invoke, on } from '../lib/api'
import type { UsageAgent, UsageLimits, UsageReport } from './types'

// Shared usage state for the top-bar pill and the usage drawer.

export interface Budget {
  /** tokens per rolling 5-hour session (input + output + cache writes) */
  session: number
  /** tokens per rolling 7-day week */
  week: number
}
export type Budgets = Record<UsageAgent, Budget>

export const DEFAULT_BUDGETS: Budgets = {
  claude: { session: 6_000_000, week: 80_000_000 },
  codex: { session: 6_000_000, week: 80_000_000 },
  gemini: { session: 6_000_000, week: 80_000_000 }
}

export const USAGE_AGENT_META: Record<UsageAgent, { label: string; color: string }> = {
  claude: { label: 'Claude', color: 'var(--accent)' },
  codex: { label: 'Codex', color: 'var(--blue)' },
  gemini: { label: 'Gemini', color: '#3ecf8e' }
}
export const USAGE_AGENT_IDS: UsageAgent[] = ['claude', 'codex', 'gemini']

interface UsageState {
  limits: Partial<Record<UsageAgent, UsageLimits>>
  budgets: Budgets
  report: UsageReport | null
  loading: boolean
  progress: { done: number; total: number } | null
  refreshLimits: () => Promise<void>
  refreshReport: (force?: boolean) => Promise<void>
  setBudget: (agent: UsageAgent, patch: Partial<Budget>) => void
}

export const useUsage = create<UsageState>((set, get) => ({
  limits: {},
  budgets: DEFAULT_BUDGETS,
  report: null,
  loading: false,
  progress: null,
  refreshLimits: async () => {
    try {
      const list = await invoke<UsageLimits[]>('usage:limits')
      set({ limits: Object.fromEntries(list.map((l) => [l.agent, l])) })
    } catch {
      /* main module not loaded yet */
    }
  },
  refreshReport: async (force) => {
    set({ loading: true })
    try {
      const report = await invoke<UsageReport>('usage:tokens', { force })
      set({ report })
      if (force) await get().refreshLimits()
    } catch {
      /* ignore */
    } finally {
      set({ loading: false, progress: null })
    }
  },
  setBudget: (agent, patch) => {
    const budgets = { ...get().budgets, [agent]: { ...get().budgets[agent], ...patch } }
    set({ budgets })
    invoke('store:setGlobal', 'usageBudget', budgets)
  }
}))

/** 0..1+ share of the budget used in the current window. */
export function usedPct(l: UsageLimits | undefined, budget: Budget, which: 'session' | 'week' = 'session') {
  if (!l) return 0
  const w = l[which]
  if (!w.active) return 0
  const b = which === 'session' ? budget.session : budget.week
  return b > 0 ? w.tokens / b : 0
}

export const pctTone = (p: number) => (p >= 0.9 ? 'danger' : p >= 0.7 ? 'warn' : 'ok')
export const toneColor = (p: number) => (p >= 0.9 ? 'var(--danger)' : p >= 0.7 ? 'var(--warn)' : 'var(--accent)')

let watching = false
/** Start polling once (called from the continuity feature entry). */
export function startUsageWatch() {
  if (watching) return
  watching = true
  const s = useUsage.getState
  invoke<Budgets | undefined>('store:getGlobal', 'usageBudget').then((b) => {
    if (b && typeof b === 'object') useUsage.setState({ budgets: { ...DEFAULT_BUDGETS, ...b } })
  })
  s().refreshLimits()
  window.setInterval(() => s().refreshLimits(), 60_000)
  on('usage:updated', () => {
    s().refreshLimits()
    if (s().report) s().refreshReport()
  })
  on('usage:progress', (p: { done: number; total: number; finished?: boolean }) =>
    useUsage.setState({ progress: p.finished ? null : { done: p.done, total: p.total } })
  )
}
