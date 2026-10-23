import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, invoke } from '../lib/api'

export const MAX_TEXT_BYTES = 3 * 1024 * 1024

export interface FileStat {
  size: number
  mtime: number
  dir: boolean
}

export interface FileText {
  text: string | null
  error: string | null
  binary: boolean
  loading: boolean
  mtime: number
  size: number
  reload: () => void
}

/** Read a text file and re-read it whenever its mtime changes (polled). */
export function useFileText(path: string | null | undefined, pollMs = 3000): FileText {
  const [state, setState] = useState<Omit<FileText, 'reload'>>({ text: null, error: null, binary: false, loading: !!path, mtime: 0, size: 0 })
  const mtimeRef = useRef(0)
  const live = useRef<string | null | undefined>(path)
  live.current = path

  const load = useCallback(
    async (force = false) => {
      if (!path) return
      const st = await invoke<FileStat | null>('fs:stat', path).catch(() => null)
      if (live.current !== path) return
      if (!st) {
        mtimeRef.current = 0
        setState((s) => (s.error === 'File not found' ? s : { text: null, error: 'File not found', binary: false, loading: false, mtime: 0, size: 0 }))
        return
      }
      if (st.dir) {
        setState({ text: null, error: 'This is a folder', binary: false, loading: false, mtime: st.mtime, size: 0 })
        return
      }
      if (!force && st.mtime === mtimeRef.current) return
      mtimeRef.current = st.mtime
      if (st.size > MAX_TEXT_BYTES) {
        setState({ text: null, error: `File is too large to show (${(st.size / 1024 / 1024).toFixed(1)} MB)`, binary: false, loading: false, mtime: st.mtime, size: st.size })
        return
      }
      try {
        const text = await invoke<string>('fs:read', path)
        if (live.current !== path) return
        const binary = text.slice(0, 8000).includes('\u0000')
        setState({ text: binary ? null : text, error: null, binary, loading: false, mtime: st.mtime, size: st.size })
      } catch (e: any) {
        setState({ text: null, error: errorText(e), binary: false, loading: false, mtime: st.mtime, size: st.size })
      }
    },
    [path]
  )

  useEffect(() => {
    mtimeRef.current = 0
    setState({ text: null, error: null, binary: false, loading: !!path, mtime: 0, size: 0 })
    if (!path) return
    load(true)
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), pollMs)
    return () => window.clearInterval(id)
  }, [path, pollMs, load])

  return { ...state, reload: () => load(true) }
}
