import type { CSSProperties } from 'react'
import { useVoice } from './thread'
import { useMotion } from '../ui/motion'

/** Isolated so audio levels don't re-render the command input on every sample. */
export function OracleOrb() {
  const motion = useMotion()
  const phase = useVoice((s) => s.phase)
  const speaking = useVoice((s) => s.speaking)
  const input = useVoice((s) => motion === 'off' ? 0 : s.level)
  const output = useVoice((s) => motion === 'off' ? null : s.outputLevel)
  const state = phase === 'listening' ? 'listening' : phase === 'thinking' || phase === 'transcribing' ? 'thinking' : speaking ? 'speaking' : 'idle'
  const level = motion === 'off' ? 0 : Math.min(1, Math.max(0, state === 'listening' ? input : output ?? 0))
  return <span className={`oracle-orb ${state} ${speaking && output == null ? 'system-speech' : ''}`} title={state === 'idle' ? 'Oracle' : state} style={{ '--audio-level': level } as CSSProperties}>
    <span className="orb" /><span className="oracle-orbit" /><span className="oracle-halo" />
  </span>
}
