import type { BoardNode } from '@shared/types'
import { activeWs, useApp } from '../state/store'
import { memberOf } from '../engine/fleet'
import { contentOrigin, tidyLayout, tidyUnits, type TidyMove } from './place'
import { flushSync } from 'react-dom'
import { currentMotion } from '../ui/motion'
import { motionDuration } from '@shared/motion'

let stopTidy: (() => void) | undefined

/** Persist the destination immediately; only the presentation interpolates. */
function moveLayout(moves: TidyMove[], wsId: string) {
  stopTidy?.()
  const duration = motionDuration(currentMotion())
  flushSync(() => {
    for (const m of moves) useApp.getState().moveNodes(m.ids, m.dx, m.dy)
  })
  const animations: Animation[] = []
  if (duration) {
    const offsets = new Map(moves.flatMap((m) => m.ids.map((id) => [id, m] as const)))
    document.querySelectorAll<HTMLElement | SVGElement>('.board [data-node-id], .board [data-group-id], .board [data-wire-from], .board [data-ink-id]').forEach((el) => {
      const id = el.dataset.nodeId ?? el.dataset.groupId ?? el.dataset.wireFrom ?? el.dataset.inkId
      const move = id && offsets.get(id)
      if (!move) return
      animations.push(el.animate([
        { transform: `translate(${-move.dx}px, ${-move.dy}px)`, contentVisibility: 'visible' },
        { transform: 'translate(0px, 0px)', contentVisibility: 'visible' }
      ], { duration, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }))
    })
  }
  const finish = () => {
    animations.forEach((a) => a.cancel())
    document.removeEventListener('pointerdown', interrupt, true)
    document.removeEventListener('keydown', interrupt, true)
    clearTimeout(timer)
    if (stopTidy === interrupt) stopTidy = undefined
  }
  const interrupt = () => finish()
  const timer = window.setTimeout(() => {
    finish()
    if (activeWs()?.id === wsId) useApp.getState().fitAll()
  }, duration + 30)
  stopTidy = interrupt
  document.addEventListener('pointerdown', interrupt, true)
  document.addEventListener('keydown', interrupt, true)
}

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
  moveLayout(moves, ws.id)
  const wsId = ws.id
  app.toast(`Tidied ${moves.length} ${moves.length === 1 ? 'thing' : 'things'} into rows.`, 'ok', {
    label: 'Undo',
    run: () => {
      // moves are relative, so this is right as long as it is still the board that was tidied
      if (activeWs()?.id !== wsId) return
      moveLayout(moves.map((m) => ({ ...m, dx: -m.dx, dy: -m.dy })), wsId)
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
