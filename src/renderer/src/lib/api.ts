import type { FbApi } from '../../../preload/index'
import type { CliRunRequest } from '@shared/types'

declare global {
  interface Window {
    fb: FbApi
  }
}

export const fb = window.fb
export const invoke = <T = any>(channel: string, ...args: unknown[]) => fb.invoke(channel, ...args) as Promise<T>
export const on = fb.on

/**
 * What to show a person for a failed call. Electron wraps a handler's thrown error as
 * `Error invoking remote method 'x': Error: …`, and only the part after that is meant for them.
 * invoke() itself keeps the wrapping: the channel name is all strayErrors.ts has to log for an IPC
 * failure nobody caught.
 */
export const errorText = (e: unknown) => String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** Windows can't pause a process (no SIGSTOP): Pause controls are hidden there. */
export const IS_WIN = fb.platform === 'win32'
export const CAN_PAUSE = !IS_WIN

let counter = 0
export const uid = (prefix = '') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * Run a one-shot prompt through the user's own CLI (claude -p by default).
 * onChunk receives streamed text; the promise resolves with the full text.
 */
export function runCli(
  req: Omit<CliRunRequest, 'runId'>,
  onChunk?: (chunk: string, all: string) => void,
  onActivity?: (line: string) => void
) {
  const runId = uid('run')
  let all = ''
  const offChunk = on('cli:chunk', (id: string, chunk: string) => {
    if (id !== runId) return
    all += chunk
    onChunk?.(chunk, all)
  })
  const offAct = on('cli:activity', (id: string, line: string) => id === runId && onActivity?.(line))
  const promise = invoke<{ code: number; text: string }>('cli:run', { ...req, runId }).finally(() => {
    offChunk()
    offAct()
  })
  return { runId, promise, cancel: () => invoke('cli:cancel', runId) }
}

/** Pull the first JSON object/array out of a model reply (tolerates ``` fences and prose). */
export function extractJson<T = any>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.search(/[[{]/)
    if (start < 0) continue
    for (let end = c.length; end > start; end--) {
      const ch = c[end - 1]
      if (ch !== '}' && ch !== ']') continue
      try {
        return JSON.parse(c.slice(start, end)) as T
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null
}


/** URL the renderer can load for a local file (images, PDFs, video). Windows paths become fbfile:///C:/… */
export const fileUrl = (path: string) => {
  const p = path.replace(/\\/g, '/')
  return `fbfile://${encodeURI(p.startsWith('/') ? p : `/${p}`).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
