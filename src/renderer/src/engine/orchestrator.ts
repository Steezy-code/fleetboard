import { create } from 'zustand'
import { allConsoles, useApp } from '../state/store'
import { uid } from '../lib/api'
import { agentLabel, isLive, resolveTargets, sendToConsole } from './consoles'

// Orchestrator: command many consoles at once. Shared by the orchestrator drawer, the orchestrator
// board node and the voice agent.

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

/** Mention token for a name ("Maya 2" → "@Maya2"). */
export const mentionToken = (name: string) => `@${name.replace(/\s+/g, '')}`

/** Resolve one @mention word to console ids, across every workspace (consoles, teams, roles, agents). */
export function resolveMention(word: string): string[] {
  const w = word.replace(/^@/, '').trim()
  if (!w) return []
  const direct = resolveTargets(w)
  if (direct.length) return direct
  const p = useApp.getState().project
  if (!p) return []
  const key = norm(w)
  for (const ws of p.workspaces) {
    const g = ws.groups.find((x) => norm(x.name) === key || norm(x.role) === key)
    if (g) return ws.nodes.filter((n) => n.type === 'console' && n.groupId === g.id).map((n) => n.id)
  }
  const byName = allConsoles().filter((c) => norm(c.data.name) === key)
  if (byName.length) return byName.map((c) => c.id)
  return allConsoles()
    .filter((c) => norm(agentLabel(c.data.agentId)) === key || norm(c.data.agentId) === key)
    .map((c) => c.id)
}

// "@word" after a space, comma or bracket; not "@types/node" (a path) and not "bob@example.com"
const MENTION_RE = /(^|[\s,(])@([\w.\-]+)(?![\w/@])/g

/**
 * Split a command into the @mentions that name consoles (taken out of the text) and the rest. Any
 * other @word stays in the text as typed: "@Maya add @types/node and use @Injectable" sends Maya "add
 * @types/node and use @Injectable". `isTarget` tells a mention from an @word.
 */
export function parseMentions(text: string, isTarget: (word: string) => boolean = (w) => resolveMention(w).length > 0): { mentions: string[]; unknown: string[]; body: string } {
  const mentions: string[] = []
  const unknown: string[] = []
  const body = text
    .replace(MENTION_RE, (whole, pre: string, word: string) => {
      const clean = word.replace(/[.\-]+$/, '')
      if (!clean || !isTarget(clean)) {
        if (clean) unknown.push(clean)
        return whole
      }
      mentions.push(clean)
      return pre + word.slice(clean.length).replace(/^[.\-]+/, '')
    })
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[\s,:;-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { mentions, unknown, body }
}

/** Console ids wired to an orchestrator node (directly, or through a wired team). */
export function wiredConsoleIds(orchestratorId: string): string[] {
  const p = useApp.getState().project
  if (!p) return []
  const ws = p.workspaces.find((w) => w.nodes.some((n) => n.id === orchestratorId))
  if (!ws) return []
  const ids = new Set<string>()
  for (const w of ws.wires) {
    const other = w.from === orchestratorId ? w.to : w.to === orchestratorId ? w.from : null
    if (!other) continue
    const node = ws.nodes.find((n) => n.id === other)
    if (node?.type === 'console') ids.add(node.id)
    else if (ws.groups.some((g) => g.id === other)) ws.nodes.filter((n) => n.type === 'console' && n.groupId === other).forEach((n) => ids.add(n.id))
  }
  return [...ids]
}

export interface DispatchResult {
  /** text typed into the consoles (mentions stripped) */
  text: string
  /** consoles that received the text */
  sent: { id: string; name: string; text: string }[]
  /** targeted consoles without a running process */
  skipped: { id: string; name: string }[]
  /** @words that matched nothing */
  unresolved: string[]
}

/**
 * Parse @mentions out of `text` and type the rest into the mentioned consoles (or into
 * `defaultTargetIds` when nothing is mentioned), submitting with Enter.
 */
export function dispatchCommand(text: string, defaultTargetIds: string[] = allConsoles().map((c) => c.id)): DispatchResult {
  const { mentions, unknown, body } = parseMentions(text)
  // @words that name no console stay in the text; if none named one, it may be a misspelt name:
  // then nothing is sent rather than everything going to the default consoles
  const unresolved = unknown
  let targets: string[] = []
  if (mentions.length) targets = [...new Set(mentions.flatMap(resolveMention))]
  else if (!unknown.length) targets = [...new Set(defaultTargetIds)]

  const names = new Map(allConsoles().map((c) => [c.id, c.data.name as string]))
  const result: DispatchResult = { text: body, sent: [], skipped: [], unresolved }
  if (!body) return result
  for (const id of targets) {
    const name = names.get(id) ?? id
    if (!isLive(id)) {
      result.skipped.push({ id, name })
      continue
    }
    sendToConsole(id, body)
    result.sent.push({ id, name, text: body })
  }
  return result
}

// ---- short in-memory log of sent commands, per orchestrator (node id or 'drawer') ----

export interface CommandLogEntry {
  id: string
  at: number
  text: string
  to: string[]
  skipped: number
  unresolved: string[]
}

export const useCommandLog = create<{ logs: Record<string, CommandLogEntry[]> }>(() => ({ logs: {} }))

export function logCommand(scope: string, r: DispatchResult) {
  const entry: CommandLogEntry = {
    id: uid('cmd'),
    at: Date.now(),
    text: r.text,
    to: r.sent.map((s) => s.name),
    skipped: r.skipped.length,
    unresolved: r.unresolved
  }
  useCommandLog.setState((s) => ({ logs: { ...s.logs, [scope]: [entry, ...(s.logs[scope] ?? [])].slice(0, 12) } }))
}

/** Dispatch + log + toast; what the UI calls. */
export function commandFrom(scope: string, text: string, defaultTargetIds: string[]): DispatchResult {
  const r = dispatchCommand(text, defaultTargetIds)
  const app = useApp.getState()
  if (!r.text) {
    app.toast('Type a command after the mention', 'warn')
    return r
  }
  logCommand(scope, r)
  // with someone to send to, other @words are just part of the text (@types/node, @Injectable)
  if (!r.sent.length && r.unresolved.length) app.toast(`Not sent: no console or team called ${r.unresolved.map((u) => '@' + u).join(', ')}`, 'warn')
  else if (!r.sent.length) app.toast('No running console to send to', 'warn')
  else if (r.sent.length) app.toast(`Sent to ${r.sent.length === 1 ? r.sent[0]?.name : `${r.sent.length} agents`}`, 'ok')
  return r
}
