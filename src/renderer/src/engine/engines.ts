// Background engines started once at boot (loop runner, voice hotkeys, ...).
// Feature modules register a starter here.
const starters: (() => void)[] = []
export const registerEngine = (fn: () => void) => starters.push(fn)

let started = false
export function startEngines() {
  if (started) return
  started = true
  for (const s of starters) s()
}
