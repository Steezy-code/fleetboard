import { agentById, readsOnly } from './agents'

/** These tiers describe Fleetboard integration, independently of whether a CLI is installed. */
export function capabilitiesOf(id: string) {
  const a = agentById(id)
  const integrated = ['claude', 'codex', 'gemini'].includes(id)
  return {
    tier: id === 'shell' ? 'Shell' : integrated ? 'Integrated' : 'Terminal only',
    teams: integrated,
    prompts: integrated,
    resume: integrated && !!a?.session,
    usage: integrated,
    readOnlyPlanner: readsOnly(id),
    detail: id === 'shell' ? 'Real shell terminal; no agent orchestration.' : integrated
      ? 'Teams · prompt detection · session resume · usage · read-only planning'
      : 'Real terminal. Team orchestration, prompt detection, usage and session continuity are not validated for this CLI.'
  }
}
