import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useAsciiReveal } from 'ascii-reveal'
import { effectiveMotion, motionDuration } from '@shared/motion'
import { useApp } from '../state/store'

const query = () => window.matchMedia('(prefers-reduced-motion: reduce)')
const reduced = () => query().matches
const subscribe = (notify: () => void) => {
  const media = query()
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
export const currentMotion = () => effectiveMotion(useApp.getState().settings.motion, reduced())
export function useMotion() {
  const setting = useApp((s) => s.settings.motion)
  return effectiveMotion(setting, useSyncExternalStore(subscribe, reduced))
}
export function useMotionSync() {
  const level = useMotion()
  useEffect(() => {
    document.documentElement.dataset.motion = level
    document.documentElement.style.setProperty('--motion-duration', `${motionDuration(level)}ms`)
    if (level === 'off') {
      document.getAnimations().forEach((animation) => animation.cancel())
    }
  }, [level])
}

/** Detach the ASCII renderer when motion is off, including an effect already in flight. */
export function useMotionReveal(options: Parameters<typeof useAsciiReveal>[0]) {
  const level = useMotion()
  const reveal = useAsciiReveal(options)
  const attach = reveal.ref
  const ref = useCallback((el: HTMLElement | null) => attach(level === 'off' ? null : el), [attach, level])
  return { ...reveal, ref }
}
