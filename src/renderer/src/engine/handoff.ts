// Hand a task from one or more consoles to another agent: summarize the outgoing session(s) with the
// user's CLI, spawn (or pick) the receiving console and type the brief into it.

import type { BoardNode, ConsoleData } from '@shared/types'
import { runCli } from '../lib/api'
import { activeWs, allConsoles, useApp } from '../state/store'
import { findFreeSpot, occupied } from '../board/place'
import { CONSOLE_H, CONSOLE_W, agentLabel, consoleTail, isLive, sendToConsole, spawnConsoles } from './consoles'

export interface HandoffRequest {
  /** console ids whose sessions are handed off */
  fromIds: string[]
  /** spawn a new console of this agent to receive the work... */
  toAgentId?: string
  /** ...or deliver to existing consoles */
  toIds?: string[]
  /** extra instruction from the user */
  note?: string
  /** a brief already written (e.g. reviewed in the handoff panel); skips summarizing */
  brief?: string
  /** streamed text while the brief is being written */
  onChunk?: (all: string) => void
}

const sourceNodes = (ids: string[]) => {
  const all = allConsoles()
  return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean) as (BoardNode<ConsoleData> & { workspaceId: string })[]
}

/** Ask the planner CLI for a concise handoff brief from the source consoles' transcripts. */
export function writeBrief(fromIds: string[], note?: string, onChunk?: (all: string) => void) {
  let cancelRun: (() => void) | null = null
  let cancelled = false
  const promise = (async () => {
    const app = useApp.getState()
    const cwd = app.project?.path
    if (!cwd) throw new Error('No project open')
    const sources = sourceNodes(fromIds)
    if (!sources.length) throw new Error('No source console')
    const transcripts = await Promise.all(
      sources.map(async (s) => `=== ${s.data.name} (${agentLabel(s.data.agentId)}) ===\n${(await consoleTail(s.id, 12000)).trim() || '(no output)'}`)
    )
    if (cancelled) throw new Error('cancelled')
    const prompt = [
      'You are writing a handoff brief so another coding agent can pick up this work in the same repository.',
      'Below is the recent terminal transcript of the agent(s) currently doing the task.',
      'Write the brief in Markdown, under 250 words, with these short sections:',
      '**Goal**, **Done so far**, **Left to do**, **Key files**, **Gotchas**.',
      'Be concrete (file paths, commands, errors). Use only the transcript; do not run tools. Output only the brief.',
      note ? `\nThe user adds: ${note}` : '',
      '',
      transcripts.join('\n\n')
    ].join('\n')
    const run = runCli({ prompt, cwd }, (_c, all) => onChunk?.(all))
    cancelRun = () => run.cancel()
    const { text, code } = await run.promise
    if (cancelled) throw new Error('cancelled')
    const brief = text.trim()
    if (!brief || (code && brief.length < 40)) throw new Error(brief || 'The CLI returned nothing')
    return brief
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      cancelRun?.()
    }
  }
}

/**
 * The free spot nearest to the right of `n`, clear of other tiles, other teams' frames and drawings.
 * The receiver joins n's group, so that group's own frame is not an obstacle: it grows around the
 * newcomer (fitGroup), where counting it would push the receiver outside the team it is joining.
 */
function spotBeside(n: BoardNode) {
  const ws = activeWs()
  const near = { x: n.x + n.w + 48, y: n.y }
  if (!ws) return near
  const others = occupied({ ...ws, groups: ws.groups.filter((g) => g.id !== n.groupId) })
  return findFreeSpot(others, { w: CONSOLE_W, h: CONSOLE_H }, near, 24)
}

/** Compose the message typed into the receiving console. */
function message(sources: BoardNode<ConsoleData>[], brief: string, note?: string) {
  const from = sources.map((s) => `${s.data.name} (${agentLabel(s.data.agentId)})`).join(', ')
  return `You are taking over a task from ${from}. Handoff brief: ${brief}${note ? ` Extra instruction: ${note}` : ''} Continue the work from here.`
}

/**
 * Summarize the source consoles, deliver the brief to a new console of `toAgentId` (spawned next to
 * the first source, in its team) or to `toIds`, and wire source → receiver. Returns receiver ids.
 */
export async function handoff(req: HandoffRequest): Promise<string[]> {
  if (!sourceNodes(req.fromIds).length) throw new Error('Pick at least one console to hand off')
  if (!req.toAgentId && !req.toIds?.length) throw new Error('Pick who receives the work')
  const projectId = useApp.getState().project?.id

  const brief = req.brief?.trim() || (await writeBrief(req.fromIds, req.note, req.onChunk).promise)
  // Writing the brief is a model run, often tens of seconds. Everything below is read again now: the
  // store, and the sources' workspace and group, as they are after it. Read before the await, a
  // workspace switch meanwhile spawned the receiver in the wrong one, and another project opened
  // meanwhile was pointed at a workspace id it does not have — an empty board.
  const app = useApp.getState()
  if (app.project?.id !== projectId) throw new Error('Another project was opened while the brief was written, so nothing was handed off')
  const sources = sourceNodes(req.fromIds)
  const first = sources[0]
  if (!first) throw new Error('The consoles handing off are no longer on the board')
  // receivers land in the first source's workspace
  if (app.project && app.project.activeWorkspaceId !== first.workspaceId) app.switchWorkspace(first.workspaceId)
  const text = message(sources, brief, req.note)

  let receivers: string[]
  if (req.toIds?.length) {
    receivers = req.toIds.filter((id) => !req.fromIds.includes(id))
    for (const id of receivers) {
      if (isLive(id)) sendToConsole(id, text)
      else useApp.getState().updateNodeData(id, { pendingPrompt: text })
    }
  } else {
    const at = spotBeside(first)
    receivers = spawnConsoles({
      agentId: req.toAgentId,
      group: first.groupId,
      // spawnConsoles offsets by its own padding / group header
      at: { x: at.x - 24, y: at.y - (first.groupId ? 58 : 0) },
      initialPrompt: text
    })
  }
  const ws = activeWs()
  for (const s of sources) for (const r of receivers) if (ws?.nodes.some((n) => n.id === s.id) && ws.nodes.some((n) => n.id === r)) useApp.getState().addWire(s.id, r)
  const onlyReceiver = receivers.length === 1 ? receivers[0] : undefined
  if (onlyReceiver) window.setTimeout(() => useApp.getState().focusItem(onlyReceiver), 80)
  const names = receivers.map((id) => allConsoles().find((c) => c.id === id)?.data.name ?? id)
  useApp.getState().toast(`Handed off to ${names.join(', ')}`, 'ok')
  return receivers
}
