import type { BoardNode, Group, InkItem, Wire } from '@shared/types'
import { activeWs, useApp } from '../state/store'
import { mayRemove } from './removeHooks'

// Delete on the board: everything selected goes in one step, and one Undo brings it back.
//
// It used to remove wires, groups and ink at once and only then ask about live consoles, so Cancel
// on "close 3 running agents?" kept the consoles but lost the team's frame, its wires and the notes
// drawn over it; and nothing could bring back a note deleted by a Backspace meant for something else.
// Now the tiles are asked first (the only question), and whatever is removed is kept for the toast's
// Undo. A console that was closed comes back as a tile that offers to resume its conversation rather
// than starting a new one.

interface Removed {
  wsId: string
  nodes: BoardNode[]
  groups: Group[]
  wires: Wire[]
  ink: InkItem[]
  /** members of a removed group, which lose their groupId with it */
  members: [string, string][]
}

export function deleteSelection(): Promise<boolean> {
  return deleteItems(useApp.getState().selection)
}

/**
 * Delete these items of the active workspace (tiles, groups, wires, ink) the way Delete does: live
 * consoles asked about first, one Undo for the lot. False when nothing went (refused, or nothing there).
 * Voice's "delete the group" comes through here too, so it gets the same question and the same Undo.
 */
export async function deleteItems(ids: string[], opts: { ask?: boolean } = {}): Promise<boolean> {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws || !ids.length) return false
  const sel = new Set(ids)
  const nodes = ws.nodes.filter((n) => sel.has(n.id))
  if (opts.ask !== false && !(await mayRemove(nodes))) return false
  const groups = ws.groups.filter((g) => sel.has(g.id))
  const gone = new Set([...nodes.map((n) => n.id), ...groups.map((g) => g.id)])
  const removed: Removed = {
    wsId: ws.id,
    nodes,
    groups,
    // a wire goes with either of its ends, as removeNodes and removeGroup already did
    wires: ws.wires.filter((w) => sel.has(w.id) || gone.has(w.from) || gone.has(w.to)),
    ink: ws.ink.filter((i) => sel.has(i.id)),
    members: ws.nodes.filter((n) => n.groupId && groups.some((g) => g.id === n.groupId) && !sel.has(n.id)).map((n) => [n.id, n.groupId!])
  }
  if (app.focusedNode && sel.has(app.focusedNode)) app.exitFocus()
  const wires = new Set(removed.wires.map((w) => w.id))
  const ink = new Set(removed.ink.map((i) => i.id))
  const lone = new Set(removed.members.map(([id]) => id))
  app.mutateWsById(ws.id, (w) => ({
    ...w,
    nodes: w.nodes.filter((n) => !gone.has(n.id)).map((n) => (lone.has(n.id) ? { ...n, groupId: undefined } : n)),
    groups: w.groups.filter((g) => !gone.has(g.id)),
    wires: w.wires.filter((x) => !wires.has(x.id)),
    ink: w.ink.filter((i) => !ink.has(i.id))
  }))
  app.setSelection(app.selection.filter((id) => !sel.has(id)))
  const count = nodes.length + groups.length + removed.ink.length + removed.wires.filter((w) => sel.has(w.id)).length
  app.toast(`Deleted ${count} ${count === 1 ? 'item' : 'items'}.`, 'info', { label: 'Undo', run: () => restore(removed) })
  return count > 0
}

function restore(r: Removed) {
  const app = useApp.getState()
  if (!app.project?.workspaces.some((w) => w.id === r.wsId)) return
  const members = new Map(r.members)
  // a console comes back offering to resume, never as a fresh session that spends on its own
  const nodes = r.nodes.map((n) => (n.type === 'console' ? { ...n, data: { ...n.data, launch: 'ask' } } : n))
  app.mutateWsById(r.wsId, (w) => ({
    ...w,
    nodes: [...w.nodes.map((n) => (members.has(n.id) ? { ...n, groupId: members.get(n.id) } : n)), ...nodes.filter((n) => !w.nodes.some((x) => x.id === n.id))],
    groups: [...w.groups, ...r.groups.filter((g) => !w.groups.some((x) => x.id === g.id))],
    wires: [...w.wires, ...r.wires.filter((x) => !w.wires.some((y) => y.id === x.id))],
    ink: [...w.ink, ...r.ink.filter((i) => !w.ink.some((x) => x.id === i.id))]
  }))
}
