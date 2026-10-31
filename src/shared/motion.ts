export type MotionLevel = 'off' | 'subtle' | 'full'

export function effectiveMotion(value: unknown, reduced: boolean): MotionLevel {
  if (reduced || value === 'off') return 'off'
  return value === 'full' ? 'full' : 'subtle'
}

export const motionDuration = (level: MotionLevel) => level === 'off' ? 0 : level === 'full' ? 700 : 240

/** Event motion: longer and brighter on Full, quick on Subtle, nothing at all when off. */
export const eventDuration = (level: MotionLevel) => level === 'off' ? 0 : level === 'full' ? 620 : 220

/**
 * Cards drop to compact labels below ZOOM_COMPACT_IN and get their detail back above
 * ZOOM_COMPACT_OUT. The gap is hysteresis: one threshold means a trackpad hovering on it flickers
 * the whole board between the two layouts, several times a second.
 */
export const ZOOM_COMPACT_IN = 0.5
export const ZOOM_COMPACT_OUT = 0.62
export const compactAtZoom = (zoom: number, wasCompact: boolean) =>
  wasCompact ? zoom < ZOOM_COMPACT_OUT : zoom < ZOOM_COMPACT_IN

/** Keys present now that were not there before (inbox arrival: a refresh of the same items is not an arrival). */
export const arrivedKeys = (before: Iterable<string>, now: readonly string[]) => {
  const had = new Set(before)
  return now.filter((k) => !had.has(k))
}
