import type { Camera } from '@shared/types'

/** Keep nearby content ready while skipping layout/paint far outside the viewport. Never unmount PTYs. */
export function offscreen(box: { x: number; y: number; w: number; h: number }, camera: Camera, viewport: { w: number; h: number }, margin = 240): boolean {
  const x = box.x * camera.zoom + camera.x
  const y = box.y * camera.zoom + camera.y
  return x + box.w * camera.zoom < -margin || y + box.h * camera.zoom < -margin || x > viewport.w + margin || y > viewport.h + margin
}
