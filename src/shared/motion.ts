export type MotionLevel = 'off' | 'subtle' | 'full'

export function effectiveMotion(value: unknown, reduced: boolean): MotionLevel {
  if (reduced || value === 'off') return 'off'
  return value === 'full' ? 'full' : 'subtle'
}

export const motionDuration = (level: MotionLevel) => level === 'off' ? 0 : level === 'full' ? 700 : 240
