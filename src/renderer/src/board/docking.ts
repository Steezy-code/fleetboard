import type { BoardNode, Group } from '@shared/types'
import { groupAt, snap } from './geometry'
import { currentMotion } from '../ui/motion'

/** Preview exactly the same grid and group target used when the pointer is released. */
export function dockingPreview() {
  let target: Element | null = null
  let ghost: HTMLDivElement | null = null
  const clear = () => {
    target?.classList.remove('dock-target')
    target = null
    ghost?.remove()
    ghost = null
  }
  return {
    clear,
    update(node: BoardNode, groups: Group[]) {
      const group = groupAt(groups, node.x + node.w / 2, node.y + 20)
      const next = group ? document.querySelector(`[data-group-id="${CSS.escape(group.id)}"]`) : null
      if (target !== next) {
        target?.classList.remove('dock-target')
        target = next
        target?.classList.add('dock-target')
      }
      if (!ghost) {
        ghost = document.createElement('div')
        ghost.className = 'dock-preview'
        ghost.setAttribute('aria-hidden', 'true')
        document.querySelector('.board .world')?.append(ghost)
      }
      Object.assign(ghost.style, { left: `${snap(node.x)}px`, top: `${snap(node.y)}px`, width: `${node.w}px`, height: `${node.h}px` })
    },
    settle(ids: string[]) {
      clear()
      if (currentMotion() === 'off') return
      for (const id of ids) {
        document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.animate([
          { transform: 'scale(1)' }, { transform: 'scale(1.006)', offset: 0.35 }, { transform: 'scale(1)' }
        ], { duration: currentMotion() === 'full' ? 220 : 140, easing: 'ease-out' })
      }
    }
  }
}
