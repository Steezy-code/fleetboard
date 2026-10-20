import type { ConsoleData, MemoryCard, Project } from '@shared/types'
import { invoke, uid } from '../lib/api'
import { useApp } from '../state/store'
import { sendToConsole } from '../engine/consoles'

// Memory cards: per-repo (project extras 'memory') and global (store global 'memory').
// Nothing reaches a console unless the user pushes it.

export const CATEGORIES: MemoryCard['category'][] = ['Context', 'Architecture', 'Structure', 'Commands', 'Conventions', 'Gotchas']

export const CATEGORY_TINT: Record<MemoryCard['category'], string> = {
  Context: '#60a5fa',
  Architecture: '#c084fc',
  Structure: '#3ecf8e',
  Commands: '#ff7a45',
  Conventions: '#f5b740',
  Gotchas: '#f43f5e'
}

export const repoCards = (): MemoryCard[] => (useApp.getState().project?.extras.memory as MemoryCard[] | undefined) ?? []
export const setRepoCards = (cards: MemoryCard[]) => useApp.getState().setProjectExtra('memory', cards)

export const loadGlobalCards = async () => ((await invoke<MemoryCard[] | undefined>('store:getGlobal', 'memory')) ?? []) as MemoryCard[]
export const saveGlobalCards = (cards: MemoryCard[]) => invoke('store:setGlobal', 'memory', cards)

export function newCard(partial: Partial<MemoryCard> & Pick<MemoryCard, 'scope'>): MemoryCard {
  const now = Date.now()
  return {
    id: uid('mem'),
    category: 'Context',
    title: '',
    body: '',
    createdAt: now,
    updatedAt: now,
    repoPath: partial.scope === 'repo' ? useApp.getState().project?.path : undefined,
    ...partial
  }
}

export const normalizeCategory = (c: unknown): MemoryCard['category'] => {
  const s = String(c ?? '').toLowerCase()
  return CATEGORIES.find((k) => k.toLowerCase() === s || s.startsWith(k.toLowerCase().slice(0, 5))) ?? 'Context'
}

/** Markdown document of cards grouped by category. */
export function cardsToMarkdown(cards: MemoryCard[], title = 'Project memory'): string {
  const lines = [`# ${title}`, '']
  for (const cat of CATEGORIES) {
    const list = cards.filter((c) => c.category === cat)
    if (!list.length) continue
    lines.push(`## ${cat}`, '')
    for (const c of list) lines.push(`- **${c.title}** — ${c.body.replace(/\n+/g, ' ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** One compact line block typed into a console. */
export function pushBlock(cards: MemoryCard[]): string {
  const items = cards.map((c, i) => `${i + 1}) [${c.category}] ${c.title}: ${c.body.replace(/\s+/g, ' ').trim()}`)
  return `Project memory (keep this in mind for the rest of the session; no reply needed): ${items.join(' ')}`
}

/** A console the user can push memory into. */
export interface PushTarget {
  id: string
  name: string
  agentId: string
  /** a process is running in it, so it is preselected */
  live: boolean
  /** the workspace it sits in, to tell two consoles with the same name apart */
  ws: string
}

/**
 * The consoles on the board, in workspace order.
 *
 * Returned as objects rather than packed into one delimited string per console: a console or a
 * workspace may be named anything, and a name holding the delimiter shifted every field after it —
 * a console called "build | web" took its workspace name as its agent, and came out not live, so it
 * was neither preselected nor coloured right.
 */
export function pushTargets(p: Project, live: Record<string, boolean>): PushTarget[] {
  return p.workspaces.flatMap((w) =>
    w.nodes
      .filter((n) => n.type === 'console')
      .map((n) => {
        const d = n.data as ConsoleData
        return { id: n.id, name: d.name, agentId: d.agentId, live: !!live[n.id], ws: w.name }
      })
  )
}

export function pushToConsoles(cards: MemoryCard[], ids: string[], submit: boolean) {
  const text = pushBlock(cards)
  for (const id of ids) sendToConsole(id, text, submit)
}

export function scanPrompt(projectPath: string, existing: MemoryCard[]): string {
  const skip = existing.length ? `\nAlready known (do not repeat): ${existing.map((c) => c.title).join('; ')}.` : ''
  return `You are writing durable project memory for AI coding agents that will work in the repository at ${projectPath}.

Read the repo first: README and docs, package manifests and lockfiles, build/test config, CI files, and the main source folders.

Then reply with ONLY a JSON array of 6 to 12 facts, no prose before or after:
[{"category": "Context" | "Architecture" | "Structure" | "Commands" | "Conventions" | "Gotchas", "title": "short title, max 8 words", "body": "1-3 concrete sentences with real paths, commands and names"}]

Categories: Context = what the project is and who it is for. Architecture = main components and how data flows. Structure = where things live. Commands = how to build, run, test, lint. Conventions = code style and patterns to follow. Gotchas = traps, footguns, non-obvious requirements.
Only facts that stay true for weeks. No TODOs, no temporary state, no guesses.${skip}`
}
