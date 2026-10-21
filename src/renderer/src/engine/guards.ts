import { allConsoles, useApp } from '../state/store'
import { USAGE_AGENT_IDS, useUsage, usedPct, type Budget } from '../continuity/usageStore'
import type { UsageAgent } from '../continuity/types'
import { journal } from '../lib/journal'

// May the app spend tokens on its own right now?
//
// One place answers that, the way roots.ts answers "may this path be touched?". Everything unattended
// asks before it spends: a loop before it types into a console, a goal judge before it runs, the CI
// watcher before it spawns a fixer. The measurement already existed and was already on screen — the
// usage pill goes red at 90% of a budget — and nothing acted on it. describeLoop even tells the user a
// loop with no limits "runs until you turn it off".
//
// What the user does by hand is never gated. A ceiling that stopped you typing into your own console
// would be the wrong thing, and it is not what overspends while you are asleep.

const isUsageAgent = (id: unknown): id is UsageAgent => USAGE_AGENT_IDS.includes(id as UsageAgent)

/** Whether this agent's own ceiling has been reached, in either window. */
export function atCeiling(agent: string): boolean {
  if (!isUsageAgent(agent)) return false // a custom agent has no usage log to read, so nothing to measure
  const { limits, budgets } = useUsage.getState()
  const budget: Budget = budgets[agent]
  if (!budget.ceiling) return false
  return usedPct(limits[agent], budget, 'session') >= budget.ceiling || usedPct(limits[agent], budget, 'week') >= budget.ceiling
}

const told = new Map<string, number>()
/** Say it once an hour per agent: a loop asks every five seconds. */
function say(agent: string, what: string) {
  if (Date.now() - (told.get(agent) ?? 0) < 3_600_000) return
  told.set(agent, Date.now())
  const pct = Math.round((isUsageAgent(agent) ? useUsage.getState().budgets[agent].ceiling : 0) * 100)
  const text = `${agent} is at ${pct}% of its budget, so Fleetboard stopped ${what} by itself. Your own prompts still go through; raise the budget or the ceiling in Usage.`
  useApp.getState().toast(text, 'warn')
  journal('guard.ceiling', text, { agent, what })
}

/**
 * Of these consoles, the ones the app may still spend on. Partial on purpose: one exhausted agent
 * should not stop a loop firing into the consoles of another.
 */
export function spendable(ids: string[], what: string): string[] {
  const agentOf = new Map(allConsoles().map((c) => [c.id, String(c.data.agentId ?? '')]))
  return ids.filter((id) => {
    const agent = agentOf.get(id) ?? ''
    if (!atCeiling(agent)) return true
    say(agent, what)
    return false
  })
}

/** For a one-shot run of a named agent (a goal judge, a CI fixer, a headless summary). */
export function maySpendOn(agent: string, what: string): boolean {
  if (!atCeiling(agent)) return true
  say(agent, what)
  return false
}
