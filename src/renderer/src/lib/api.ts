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

export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
export const relPath = (root: string, p: string) => (p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, '') : p)

/** URL the renderer can load for a local file (images, PDFs, video). */
export const fileUrl = (path: string) => `fbfile://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
