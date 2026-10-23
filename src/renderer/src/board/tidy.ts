import type { BoardNode } from '@shared/types'
import { activeWs, useApp } from '../state/store'
import { memberOf } from '../engine/fleet'
import { contentOrigin, tidyLayout, tidyUnits } from './place'

// Two ways to get a long session's board back: Tidy packs what is there into rows, keeping what
// belongs together together (place.ts), with one Undo; Clear finished takes away the consoles whose
// programs have ended, which otherwise stay on the board for good.

/** Pack the board into rows. One toast, with an Undo that puts every unit back where it was. */
export function tidyBoard() {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws) return
  const units = tidyUnits(ws)
  const moves = units.length > 1 ? tidyLayout(units, contentOrigin(units)) : []
  if (!moves.length) return app.toast('Already tidy.')
  for (const m of moves) app.moveNodes(m.ids, m.dx, m.dy)
  window.setTimeout(() => useApp.getState().fitAll(), 30)
  const wsId = ws.id
  app.toast(`Tidied ${moves.length} ${moves.length === 1 ? 'thing' : 'things'} into rows.`, 'ok', {
    label: 'Undo',
    run: () => {
      // moves are relative, so this is right as long as it is still the board that was tidied
      if (activeWs()?.id !== wsId) return
      for (const m of moves) useApp.getState().moveNodes(m.ids, -m.dx, -m.dy)
      window.setTimeout(() => useApp.getState().fitAll(), 30)
    }
  })
}

/**
 * Consoles on this board whose program has ended. Not a team's: the team removes its own, and a
 * Lead that stopped mid-task is a card in the Inbox that needs its tile to resume from.
 */
export function finishedConsoles(): BoardNode[] {
  const { statuses } = useApp.getState()
  return (activeWs()?.nodes ?? []).filter((n) => n.type === 'console' && statuses[n.id] === 'exited' && !memberOf(n.id))
}

export async function clearFinished() {
  const app = useApp.getState()
  const done = finishedConsoles()
  if (!done.length) return
  const names = done.map((n) => n.data.name as string)
  const ok = await app.confirm({
    title: done.length === 1 ? `Remove ${names[0]}?` : `Remove ${done.length} finished consoles?`,
    body: `${names.join(', ')} ${done.length === 1 ? 'has' : 'have'} ended. Removing ${done.length === 1 ? 'its tile' : 'their tiles'} drops the scrollback from the board; a conversation can still be resumed from its CLI.`,
    confirm: 'Remove'
  })
  if (!ok) return
  // checked again: one may have been restarted while the question was up
  const still = new Set(finishedConsoles().map((n) => n.id))
  app.removeNodes(done.map((n) => n.id).filter((id) => still.has(id)))
}
