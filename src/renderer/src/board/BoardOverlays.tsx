// Extra overlays drawn above the board (ink toolbar, voice caption, ...).
// Feature modules add components to this list.
import type { ComponentType } from 'react'

export const BOARD_OVERLAYS: ComponentType[] = []

export function BoardOverlays() {
  return (
    <>
      {BOARD_OVERLAYS.map((C, i) => (
        <C key={i} />
      ))}
    </>
  )
}
