import { create } from 'zustand'
import type { FleetState } from '@shared/fleet'
import { teamRuleAllowed } from '@shared/approvals'

// One yes for a whole team. Four workers each stop to ask whether they may run `npm test`, and the
// Inbox makes you say yes four times, in four worktrees, about the same command. "Allow for the
// team" says it once: from then on that command, asked by anyone on that team, is answered for you
// (inboxModel.ts), for as long as the team exists.
//
// The match is the whole command, character for character (commandOf in approvals.ts), never a
// prefix: `npm test` approves `npm test` and not `npm test && curl …`. Main re-reads the screen and
// types nothing unless the prompt still asks for that exact command (pty.ts answer). Commands that
// delete, overwrite, run as root or reach the network never get a rule (teamRuleAllowed). Each
// answer a rule gives goes into the Night log, so "what did it say yes to" still has an answer.
//
// The command's text is not all a rule is bound to: `npm test` runs whatever package.json says. A
// rule carries a fingerprint of the files that define such commands, taken in the folder of the
// console the user said yes to (main/teamrules.ts), and main answers for a member only while its own
// folder still matches. A worker that rewrites the "test" script is asked again.
//
// ponytail: in memory, so a reload forgets the rules and the team asks again — the safe direction
// to fail in. Persist them with the fleet state only if re-approving after a restart proves a chore.

export interface TeamRule {
  /** the team, by its Lead's console id */
  leadId: string
  command: string
  /** the definition files where the user said yes (main/teamrules.ts definitionFingerprint) */
  fingerprint: string
  at: number
}

export const useTeamRules = create<{ rules: TeamRule[] }>(() => ({ rules: [] }))

/** The team a console is on, by its Lead's id; null for a console that is on no team. */
export function teamOf(fleet: FleetState | null | undefined, consoleId: string): string | null {
  const m = fleet?.members[consoleId]
  if (!m) return null
  return m.role === 'lead' ? m.id : (m.leadId ?? null)
}

/** Whether "Allow for the team" may be offered for this console's command. */
export const canRule = (fleet: FleetState | null | undefined, consoleId: string, command: string | undefined): command is string =>
  !!command && !!teamOf(fleet, consoleId) && teamRuleAllowed(command)

export function addRule(leadId: string, command: string, fingerprint: string) {
  if (!teamRuleAllowed(command) || !fingerprint || ruleFor(leadId, command)) return
  useTeamRules.setState((s) => ({ rules: [...s.rules, { leadId, command, fingerprint, at: Date.now() }] }))
}

export function removeRule(leadId: string, command: string) {
  useTeamRules.setState((s) => ({ rules: s.rules.filter((r) => !(r.leadId === leadId && r.command === command)) }))
}

export const ruleOf = (leadId: string, command: string) => useTeamRules.getState().rules.find((r) => r.leadId === leadId && r.command === command)
export const ruleFor = (leadId: string, command: string) => !!ruleOf(leadId, command)

export const rulesOf = (leadId: string | null) => (leadId ? useTeamRules.getState().rules.filter((r) => r.leadId === leadId) : [])

/** A rule goes with its team: once the Lead is gone (merged, done, discarded), so is every rule it had. */
export function pruneRules(fleet: FleetState | null | undefined) {
  const { rules } = useTeamRules.getState()
  const kept = rules.filter((r) => fleet?.members[r.leadId])
  if (kept.length !== rules.length) useTeamRules.setState({ rules: kept })
}
