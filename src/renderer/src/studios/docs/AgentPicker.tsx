import { useMemo } from 'react'
import type { AgentDef } from '@shared/types'
import { AGENTS, agentById } from '@shared/agents'
import { useApp } from '../../state/store'

// Model picker shared by the Document and Diagram studios: the installed CLIs that can run a
// headless one-shot prompt. Claude is always offered so the studios work before detection finishes.

export function useHeadlessAgents(): AgentDef[] {
  const agents = useApp((s) => s.agents)
  return useMemo(() => {
    const installed = AGENTS.filter((a) => a.headless && a.id !== 'shell' && agents.some((x) => x.id === a.id && x.path))
    if (!installed.some((a) => a.id === 'claude')) installed.unshift(agentById('claude')!)
    return installed
  }, [agents])
}

/** The agent to use: the requested one if it is available, else the planner agent, else Claude. */
export function resolveAgent(requested: string | null, list: AgentDef[], planner: string): AgentDef {
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
