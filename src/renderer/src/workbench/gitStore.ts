import { useEffect } from 'react'
import { create } from 'zustand'
import { invoke } from '../lib/api'
import type { GitResult, GitStatus } from '../../../main/git'

export type { GitStatus, GitFile, GitCommit, GitBranch, GitRemote, GitPr, GitResult } from '../../../main/git'

// One shared poller per repo path: the branch badge, git cards and the git drawer all read from here.

export interface GitEntry {
  status: GitStatus | null
  /** false once we know the folder is not a repo */
  isRepo: boolean | null
  error: string | null
  loading: boolean
  /** bumps whenever the status actually changed (consumers refetch log etc.) */
  version: number
}

const useGitStore = create<{ repos: Record<string, GitEntry> }>(() => ({ repos: {} }))

const EMPTY: GitEntry = { status: null, isRepo: null, error: null, loading: false, version: 0 }

const subs = new Map<string, { count: number; timer?: number; interval: number }>()
const inflight = new Map<string, Promise<void>>()
const lastJson = new Map<string, string>()

function patch(cwd: string, p: Partial<GitEntry>) {
  useGitStore.setState((s) => ({ repos: { ...s.repos, [cwd]: { ...(s.repos[cwd] ?? EMPTY), ...p } } }))
}

/** Refresh one repo's status now (deduped while a request is running). */
export function refreshGit(cwd: string | null | undefined): Promise<void> {
  if (!cwd) return Promise.resolve()
  const running = inflight.get(cwd)
  if (running) return running
  const cur = useGitStore.getState().repos[cwd]
  if (!cur?.status) patch(cwd, { loading: true })
  const p = invoke<GitResult<{ status: GitStatus }>>('git:status', cwd)
    .then((r) => {
      if (r.ok) {
        const json = JSON.stringify(r.status)
        const prev = useGitStore.getState().repos[cwd] ?? EMPTY
        if (json === lastJson.get(cwd) && prev.status) {
          if (prev.loading || prev.error) patch(cwd, { loading: false, error: null })
          return
        }
        lastJson.set(cwd, json)
        patch(cwd, { status: r.status, isRepo: true, error: null, loading: false, version: prev.version + 1 })
      } else {
        lastJson.delete(cwd)
        const notRepo = /not a git repository|folder not found/i.test(r.error)
        const prev = useGitStore.getState().repos[cwd] ?? EMPTY
        patch(cwd, { status: notRepo ? null : prev.status, isRepo: notRepo ? false : prev.isRepo, error: r.error, loading: false, version: prev.version + (notRepo && prev.status ? 1 : 0) })
      }
    })
    .catch((e) => patch(cwd, { loading: false, error: String(e?.message ?? e) }))
    .finally(() => inflight.delete(cwd))
  inflight.set(cwd, p)
  return p
}

function schedule(cwd: string) {
  const s = subs.get(cwd)
  if (!s) return
  window.clearTimeout(s.timer)
  s.timer = window.setTimeout(async () => {
    if (!subs.has(cwd)) return
    if (document.visibilityState === 'visible') await refreshGit(cwd)
    schedule(cwd)
  }, s.interval)
}

function subscribe(cwd: string, interval: number) {
  const s = subs.get(cwd)
  if (s) {
    s.count++
    if (interval < s.interval) s.interval = interval
    return
  }
  subs.set(cwd, { count: 1, interval })
  refreshGit(cwd)
  schedule(cwd)
}

function unsubscribe(cwd: string) {
  const s = subs.get(cwd)
  if (!s) return
  if (--s.count > 0) return
  window.clearTimeout(s.timer)
  subs.delete(cwd)
}

/** Live git status for a folder; polls every `interval` ms while mounted. */
export function useGitStatus(cwd: string | null | undefined, interval = 4000): GitEntry {
  useEffect(() => {
    if (!cwd) return
    subscribe(cwd, interval)
    return () => unsubscribe(cwd)
  }, [cwd, interval])
  return useGitStore((s) => (cwd ? s.repos[cwd] : undefined)) ?? EMPTY
}

/** Typed invoke for git:* channels. */
export function git<T = {}>(channel: string, ...args: unknown[]) {
  return invoke<GitResult<T>>(`git:${channel}`, ...args).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }))
}
