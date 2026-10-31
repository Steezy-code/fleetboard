import { useMotion } from './motion'

/** Two finite rings on arrival, followed by a steady marker. */
export function AttentionBeacon() {
  const motion = useMotion()
  return <span className={`attention-beacon ${motion === 'off' ? 'still' : ''}`} aria-hidden="true">
    <i /><i /><b />
  </span>
}
