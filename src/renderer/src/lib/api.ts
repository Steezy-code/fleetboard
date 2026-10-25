import type { IpcContract } from '@shared/ipc-contract'
import type { FbApi } from '../../../preload/index'
import type { CliRunRequest } from '@shared/types'

declare global {
  interface Window {
    fb: FbApi
  }
}

export const fb = window.fb
export const invoke = <T = any>(channel: string, ...args: unknown[]) => fb.invoke(channel, ...args) as Promise<T>
export const request = <C extends keyof IpcContract>(channel: C, ...args: IpcContract[C]['args']): Promise<IpcContract[C]['result']> => fb.invoke(channel, ...args)
export const on = fb.on

/**
 * What to show a person for a failed call. Electron wraps a handler's thrown error as
 * `Error invoking remote method 'x': Error: …`, and only the part after that is meant for them.
 * invoke() itself keeps the wrapping: the channel name is all strayErrors.ts has to log for an IPC
 * failure nobody caught.
 */
export const errorText = (e: unknown) => String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const IS_WIN = fb.platform === 'win32'

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
  const promise = request('cli:run', { ...req, runId }).finally(() => {
    offChunk()
    offAct()
  })
  return { runId, promise, cancel: () => request('cli:cancel', runId) }
}

/**
 * Where the object or array opening at `start` closes (the index just past it), or -1. Strings are
 * skipped whole, so a brace inside one does not count.
 */
function closingOf(s: string, start: number): number {
  const want: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') want.push('}')
    else if (ch === '[') want.push(']')
    else if (ch === '}' || ch === ']') {
      if (want.pop() !== ch) return -1
      if (!want.length) return i + 1
    }
  }
  return -1
}

/**
 * Pull the first JSON object/array out of a model reply (tolerates ``` fences and prose).
 *
 * Each `{` or `[` is tried in turn, up to where its brackets close: a reply that mentions "[1]" in its
 * prose before the JSON still yields the JSON. It used to try the first one only, shrinking from the
 * end one closing bracket at a time with a JSON.parse each — quadratic on a long reply, on the UI thread.
 */
export function extractJson<T = any>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  for (const c of [fenced?.[1], text]) {
    if (!c) continue
    // an object first: replies are asked for as one, and "[1]" in the prose before it is valid JSON too
    let array: unknown
    const opening = /[[{]/g
    for (let tries = 0, m = opening.exec(c); m && tries < 64; m = opening.exec(c), tries++) {
      const at = m.index
      const end = closingOf(c, at)
      if (end < 0) continue
      try {
        const v = JSON.parse(c.slice(at, end))
        if (!Array.isArray(v)) return v as T
        array ??= v
        opening.lastIndex = end
      } catch {
        /* not JSON after all: the next opening bracket */
      }
    }
    if (array !== undefined) return array as T
  }
  return null
}

/** URL the renderer can load for a local file (images, PDFs, video). Windows paths become fbfile:///C:/… */
export const fileUrl = (path: string) => {
  const p = path.replace(/\\/g, '/')
  return `fbfile://${encodeURI(p.startsWith('/') ? p : `/${p}`).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
