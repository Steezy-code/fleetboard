import { useEffect, useRef } from 'react'
import { currentMotion } from './motion'

/**
 * A workspace switch: the board recedes and settles forward again.
 *
 * ponytail: one animation on the incoming board, not a crossfade between two. The board is keyed by
 * workspace in App.tsx, so the outgoing one is unmounted before this can run, and keeping it alive
 * long enough to animate would re-mount every live terminal on the board being left — the one thing
 * a switch must not do. Starting the incoming board receded reads as the same movement.
 */
export function useWorkspaceSwap(workspaceId: string) {
  const previous = useRef<string | null>(null)
  const running = useRef<Animation | null>(null)
  useEffect(() => {
    const was = previous.current
    previous.current = workspaceId
    // the first board of the session is the launch wave's, not a switch
    if (!was || was === workspaceId || !workspaceId) return
    // a switch during a switch starts over: tab mashing must not queue up a backlog of animations
    running.current?.cancel()
    running.current = null
    const level = currentMotion()
    if (level === 'off') return
    const board = document.querySelector('.board')
    if (!board) return
    const full = level === 'full'
    const animation = board.animate(
      [
        { opacity: 0.3, transform: `scale(${full ? 0.96 : 0.985})` },
        { opacity: 1, transform: `scale(${full ? 1.008 : 1.002})`, offset: 0.7 },
        { opacity: 1, transform: 'scale(1)' }
      ],
      { duration: full ? 440 : 170, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }
    )
    running.current = animation
    void animation.finished.then(
      () => { if (running.current === animation) running.current = null },
      () => {}
    )
    return () => animation.cancel()
  }, [workspaceId])
}
