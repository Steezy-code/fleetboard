import type { AgentAvailability, AgentDef } from '@shared/types'

// Whether an agent CLI is ready to be given work, for the home screen. Installed is not enough: a
// CLI that has never been signed in starts, asks how to sign in, and the first team the user starts
// stalls on a question nobody is looking at. Finding that out on the home screen, with the one step
// that fixes it, is the difference between a first goal that works and one that quietly does not.

/** The agents the home screen always lists, installed or not: the ones teams are built for. */
export const MAIN_AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'freebuff']

export interface SignIn {
  signedIn: boolean
  account?: string
}

export type Readiness =
  | { state: 'scanning' }
  | { state: 'ready'; detail: string }
  /** installed, with no sign-in found: run it once in a terminal */
  | { state: 'signin'; detail: string; command: string }
  | { state: 'missing'; detail: string; command?: string; homepage?: string }

/**
 * `found`: what agent detection said (undefined while it has not answered yet). `signIn`: what the
 * CLI's own files say, for the CLIs Fleetboard knows how to read; undefined means it can't tell, and
 * an installed CLI it can't read is taken at its word rather than flagged.
 */
export function readinessOf(def: AgentDef, found: AgentAvailability | undefined, signIn: SignIn | undefined): Readiness {
  if (!found) return { state: 'scanning' }
  if (!found.path) return { state: 'missing', detail: 'Not installed', command: def.install, homepage: def.homepage }
  const version = found.version?.replace(/^v(?=\d)/, '').replace(new RegExp(`^${def.name}\\s*`, 'i'), '')
  if (signIn && !signIn.signedIn) return { state: 'signin', detail: 'Installed, no sign-in found', command: def.bin }
  return { state: 'ready', detail: [signIn?.account, version].filter(Boolean).join(' · ') || 'Installed' }
}
