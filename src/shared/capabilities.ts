import { agentById, readsOnly, TEAM_AGENTS } from './agents'

/** These tiers describe Fleetboard integration, independently of whether a CLI is installed. */
export function capabilitiesOf(id: string) {
  const a = agentById(id)
  const integrated = ['claude', 'codex', 'gemini'].includes(id)
  const team = TEAM_AGENTS.includes(id)
  const added = id === 'antigravity' || id === 'freebuff'
  return {
    tier: id === 'shell' ? 'Shell' : integrated ? 'Integrated' : team ? 'Teams' : 'Terminal only',
    teams: team,
    prompts: integrated,
    resume: integrated && !!a?.session,
    usage: integrated,
    readOnlyPlanner: readsOnly(id),
    detail: added ? (id === 'antigravity' ? 'Teams and read-only background planning. Team restarts receive a fresh brief; exact session recovery and usage tracking are not available.' : 'Teams through the interactive CLI and MCP, subject to Freebuff concurrent-session limits. No headless background planner; team restarts receive a fresh brief. Usage tracking is not available.') : id === 'shell' ? 'Real shell terminal; no agent orchestration.' : integrated
      ? 'Teams · prompt detection · session resume · usage · read-only planning'
      : 'Real terminal. Team orchestration, prompt detection, usage and session continuity are not validated for this CLI.'
  }
}
