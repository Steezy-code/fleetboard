import { useMemo } from 'react'
import type { AgentDef } from '@shared/types'
import { AGENTS, agentById } from '@shared/agents'
import { useApp } from '../../state/store'

// Model picker shared by the Document and Diagram studios: the installed CLIs that can run a
// headless one-shot prompt. Claude is always offered so the studios work before detection finishes.

/** The installed headless agents, Claude first when it is not among them — so never none of them. */
export function useHeadlessAgents(): [AgentDef, ...AgentDef[]] {
  const agents = useApp((s) => s.agents)
  return useMemo(() => {
    const installed = AGENTS.filter((a) => a.headless && a.id !== 'shell' && agents.some((x) => x.id === a.id && x.path))
    const [first, ...rest] = installed
    if (!first) return [agentById('claude')!]
    return installed.some((a) => a.id === 'claude') ? [first, ...rest] : [agentById('claude')!, first, ...rest]
  }, [agents])
}

/**
 * The agent to use: the requested one if it is available, else the planner agent, else the first.
 * The list is one that is never empty, which is what makes that last fallback an agent and not
 * undefined — it is Claude, put there by useHeadlessAgents.
 */
export function resolveAgent(requested: string | null, list: [AgentDef, ...AgentDef[]], planner: string): AgentDef {
  return list.find((a) => a.id === requested) ?? list.find((a) => a.id === planner) ?? list[0]
}

/** "Claude Code" → "Claude", "Gemini CLI" → "Gemini". */
export const shortName = (a: AgentDef | undefined) => (a?.name ?? 'Claude').replace(/\s+(Code|CLI)$/i, '').trim()

export function AgentPicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const list = useHeadlessAgents()
  const current = list.find((a) => a.id === value) ?? list[0]
  return (
    <div className="st-agents">
      <div className="st-agent-dots">
        {list.map((a) => (
          <button
            key={a.id}
            className={`st-agent ${a.id === current?.id ? 'on' : ''}`}
            style={{ ['--ag' as any]: a.color }}
            title={`${a.name} · ${a.vendor}`}
            disabled={disabled}
            onClick={() => onChange(a.id)}
          >
            {a.name.slice(0, 1)}
          </button>
        ))}
      </div>
      <span className="st-agent-name">{current?.name}</span>
    </div>
  )
}
