// Replay an asciicast recording (test/tools/record.mjs) through the same screen model and status
// tracker the app uses, on the recording's own clock.
import fs from 'node:fs'
import path from 'node:path'
import { TermScreen } from '../../src/main/screen'
import { StatusTracker, TERMINAL_REPLY, detectPrompt, type Prompt } from '../../src/main/status'
import type { ConsoleStatus } from '../../src/shared/types'

export const CASTS = path.join(import.meta.dirname, '../fixtures/casts')

export interface CastEvent {
  t: number
  kind: 'o' | 'i' | 'm' | 'h'
  data: any
}

export interface Cast {
  width: number
  height: number
  events: CastEvent[]
}

export function loadCast(file: string): Cast {
  const lines = fs.readFileSync(path.isAbsolute(file) ? file : path.join(CASTS, file), 'utf8').trim().split('\n')
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((l) => {
    const [t, kind, data] = JSON.parse(l)
    return { t: Math.round(t * 1000), kind, data } as CastEvent
  })
  return { width: header.width, height: header.height, events }
}

export interface MarkResult {
  mark: string
  at: number
  status: ConsoleStatus
  prompt: Prompt | null
  screen: string[]
}

/** Run the status tick (every `tick` ms) across the recording and report the state at each mark. */
export async function replay(cast: Cast, opts: { hooked?: boolean; tick?: number; ignoreHooks?: boolean } = {}): Promise<{ marks: MarkResult[]; timeline: { at: number; status: ConsoleStatus }[] }> {
  const tick = opts.tick ?? 100
  const hooked = !opts.ignoreHooks && (opts.hooked ?? cast.events.some((e) => e.kind === 'h'))
  const screen = new TermScreen(cast.width, cast.height)
  const tracker = new StatusTracker(0, hooked)
  const marks: MarkResult[] = []
  const timeline: { at: number; status: ConsoleStatus }[] = []
  let now = 0
  const advance = (to: number) => {
    for (; now + tick <= to; now += tick) {
      const s = tracker.evaluate(now + tick, detectPrompt(screen.view()))
      if (timeline[timeline.length - 1]?.status !== s) timeline.push({ at: now + tick, status: s })
    }
  }
  for (const e of cast.events) {
    advance(e.t)
    if (e.kind === 'o') {
      screen.write(e.data)
      await screen.flush()
      tracker.output(e.t)
    } else if (e.kind === 'i') {
      // as the app does: the terminal's own answers to queries are not typing
      if (!TERMINAL_REPLY.test(e.data)) tracker.input(e.t)
    } else if (e.kind === 'h' && !opts.ignoreHooks) {
      tracker.hookEvent(e.data[0], e.data[1], e.t)
    } else if (e.kind === 'm') {
      const view = screen.view()
      const prompt = detectPrompt(view)
      marks.push({ mark: e.data, at: e.t, status: tracker.evaluate(e.t, prompt), prompt, screen: view.lines })
    }
  }
  screen.dispose()
  return { marks, timeline }
}

/** Marks are named "<expected status>: <what is on screen>". */
export const expectedOf = (mark: string) => mark.split(':')[0].trim() as ConsoleStatus
