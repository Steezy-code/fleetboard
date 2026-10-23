import type { BoardNode, NodeType } from '@shared/types'
import { killConsoles } from '../engine/consoles'

// What has to happen before tiles of a type leave the board. Kept apart from the tile registry
// (nodes/registry.tsx), which pulls in every tile's component, so that deciding whether something
// may go needs none of them.

const BEFORE_REMOVE: Partial<Record<NodeType, (nodes: BoardNode[]) => Promise<boolean>>> = {
  // a live console is asked about, then closed; the tile itself is removed by the caller
  console: (nodes) => killConsoles(nodes.map((n) => n.id), { remove: false })
}

/** Whether these tiles may go: false as soon as one type says no, before anything is removed. */
export async function mayRemove(nodes: BoardNode[]): Promise<boolean> {
  const byType = new Map<NodeType, BoardNode[]>()
  for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n])
  for (const [type, list] of byType) {
    const hook = BEFORE_REMOVE[type]
    if (hook && !(await hook(list))) return false
  }
  return true
}
