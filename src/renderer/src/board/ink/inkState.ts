import { create } from 'zustand'
import type { InkItem } from '@shared/types'
import { uid } from '../../lib/api'
import { activeWs, useApp } from '../../state/store'

/** UI state of the ink layer shared with the style toolbar. */
export const useInkUi = create<{ editing: string | null }>(() => ({ editing: null }))

/**
 * Patch many ink items in one store update. With persist=false the change is live but not yet saved
 * (used while dragging); call again with persist=true (or any store action) to save.
 */
export function patchInk(patches: Record<string, Partial<InkItem>>, persist = true) {
  const s = useApp.getState()
  const p = s.project
  if (!p) return
  const ids = Object.keys(patches)
  if (!ids.length) return
  const workspaces = p.workspaces.map((w) =>
    w.id !== p.activeWorkspaceId ? w : { ...w, ink: w.ink.map((i) => (patches[i.id] ? { ...i, ...patches[i.id] } : i)) }
  )
  useApp.setState({ project: { ...p, workspaces } })
  // any store mutation schedules a save of the whole project
  if (persist) s.updateInk(ids[0], {})
}

export function selectedInk(): InkItem[] {
  const ws = activeWs()
  if (!ws) return []
  const sel = new Set(useApp.getState().selection)
  return ws.ink.filter((i) => sel.has(i.id))
}

/** Copy the selected ink a little offset and select the copies. */
export function duplicateInk(items: InkItem[]) {
  if (!items.length) return
  const d = 24
  const fig = new Map<string, string>()
  const copies = items.map((i) => {
    let figureId = i.figureId
    if (figureId) {
      if (!fig.has(figureId)) fig.set(figureId, uid('fig'))
      figureId = fig.get(figureId)
    }
    return {
      ...i,
      id: uid('ink'),
      figureId,
      x: i.x + d,
      y: i.y + d,
      points: i.points?.map(([x, y]) => [x + d, y + d] as [number, number])
    }
  })
  const app = useApp.getState()
  app.addInk(copies)
  app.setSelection(copies.map((c) => c.id))
}
