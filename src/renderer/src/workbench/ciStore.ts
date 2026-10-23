import { useEffect } from 'react'
import { create } from 'zustand'
import { invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { sendToConsole, spawnConsoles } from '../engine/consoles'
import { maySpendOn } from '../engine/guards'
import { ownerOf, refreshFeedback, setBranchAgent, useFeedback } from './prFeedback'
import type { CiPr, CiRun, CiState, CiStatus } from '../../../main/ci'

export type { CiCheck, CiPr, CiRun, CiState, CiStatus } from '../../../main/ci'

// One CI watcher for the open project: the badge, the CI drawer and notifications all read from here.

const POLL_RUNNING = 20_000
const POLL_IDLE = 60_000
const POLL_FEEDBACK = 120_000

export const useCi = create<{ status: CiStatus | null; path: string | null; loading: boolean }>(() => ({ status: null, path: null, loading: false }))

/** Something CI checks that can pass or fail: the latest run of a workflow on this branch, or an open PR. */
export interface CiItem {
  key: string
  label: string
  state: CiState
  /** changes when a new run replaces the one we saw (a rerun that fails again is news too) */
  rev: string
  branch: string
  url: string
  /** failed Actions runs to read logs from */
  runIds: number[]
  pr?: CiPr
  run?: CiRun
}

export function ciItems(s: CiStatus | null): CiItem[] {
  if (!s?.ok) return []
  const runs = s.runs.map<CiItem>((r) => ({
    key: `run:${r.workflow}`,
    label: `${r.workflow} on ${s.branch}`,
    state: r.state,
    rev: String(r.id),
    branch: s.branch,
    url: r.url,
    runIds: r.state === 'failing' ? [r.id] : [],
    run: r
  }))
  const prs = s.prs.map<CiItem>((p) => {
    const failing = p.checks.filter((c) => c.state === 'failing')
    return {
      key: `pr:${p.number}`,
      label: `PR #${p.number} ${p.title}`,
      state: p.state,
      rev: failing.map((c) => c.runId ?? c.name).join(',') || p.state,
      branch: p.branch,
      url: p.url,
      runIds: [...new Set(failing.map((c) => c.runId).filter((x): x is number => !!x))],
      pr: p
    }
  })
  return [...runs, ...prs]
}

/** The badge's one-word summary: this branch first, then whether any PR is red. */
export function ciSummary(s: CiStatus | null): { state: CiState; failingPrs: number } {
  if (!s?.ok) return { state: 'none', failingPrs: 0 }
  const states = s.runs.map((r) => r.state)
  const state: CiState = states.includes('failing') ? 'failing' : states.includes('running') ? 'running' : states.includes('passing') ? 'passing' : 'none'
  return { state, failingPrs: s.prs.filter((p) => p.state === 'failing' && p.branch !== s.branch).length }
}

// ---------- polling + notifications ----------

let seen = new Map<string, { state: CiState; rev: string }>()
const fixers = new Map<string, string>() // item key -> console id working on it
let inflight: Promise<void> | null = null

export function refreshCi(): Promise<void> {
  const path = useCi.getState().path
  if (!path) return Promise.resolve()
  if (inflight) return inflight
  useCi.setState({ loading: true })
  inflight = invoke<CiStatus>('ci:status', path)
    .then((status) => {
      if (useCi.getState().path === path) applyCiStatus(status)
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
      useCi.setState({ loading: false })
    })
  return inflight
}

/** Take in a fresh status: store it, and say (or act) when something turned red or green. */
export function applyCiStatus(status: CiStatus) {
  useCi.setState({ status })
  if (!status.ok) return
  const first = seen.size === 0
  const next = new Map<string, { state: CiState; rev: string }>()
  for (const item of ciItems(status)) {
    next.set(item.key, { state: item.state, rev: item.rev })
    const prev = seen.get(item.key)
    if (first || !prev) continue
    if (item.state === 'failing' && (prev.state !== 'failing' || prev.rev !== item.rev)) {
      notify(prev.state === 'failing' ? 'CI is still failing' : 'CI failed', item.label, 'warn')
      if (useApp.getState().project?.extras.ciAutoFix) void fixCi(item, { auto: true })
    } else if (item.state === 'passing' && prev.state === 'failing') {
      notify('CI is green again', item.label, 'info')
    }
  }
  seen = next
}

function notify(title: string, body: string, tone: 'info' | 'warn') {
  useApp.getState().toast(`${title}: ${body}`, tone)
  if (document.hasFocus() || typeof Notification === 'undefined') return
  try {
    const n = new Notification(title, { body, silent: tone === 'info' })
    n.onclick = () => {
      window.focus()
      useApp.getState().openDrawer('ci')
    }
  } catch {
    /* notifications unavailable */
  }
}

/** Mounted once (bottom-left): follows the open project and polls faster while CI is running. */
export function useCiWatcher() {
  const path = useApp((s) => s.project?.path ?? null)
  const running = useCi((s) => (s.status?.ok ? ciItems(s.status).some((i) => i.state === 'running') : false))
  useEffect(() => {
    if (useCi.getState().path !== path) {
      seen = new Map()
      useCi.setState({ path, status: null })
      useFeedback.setState({ result: null })
    }
    if (!path) return
    void refreshCi()
    const t = window.setInterval(() => void refreshCi(), running ? POLL_RUNNING : POLL_IDLE)
    const onFocus = () => void refreshCi()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [path, running])
  // review comments change slower than CI: every two minutes, and on focus
  useEffect(() => {
    if (!path) return
    void refreshFeedback()
    const t = window.setInterval(() => void refreshFeedback(), POLL_FEEDBACK)
    const onFocus = () => void refreshFeedback()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [path])
}

// ---------- sending an agent to fix it ----------

export function fixerFor(key: string): string | null {
  const id = fixers.get(key)
  return id && allConsoles().some((c) => c.id === id) ? id : null
}

export async function fixCi(item: CiItem, opts: { auto?: boolean } = {}): Promise<string | null> {
  const app = useApp.getState()
  const status = useCi.getState().status
  const path = useCi.getState().path
  if (!app.project || !status?.ok || !path) return null
  // Automatic only: when the user presses Fix it themselves, that is their call to make. Spawning an
  // agent is the most expensive thing this app does on its own.
  if (opts.auto && !maySpendOn(app.settings.plannerAgent, 'sending an agent at a CI failure')) return null
  const busy = fixerFor(item.key)
  if (busy) {
    if (!opts.auto) app.focusItem(busy)
    return busy
  }
  const logs: string[] = []
  for (const id of item.runIds.slice(0, 3)) {
    const r = await invoke<{ ok: true; log: string } | { ok: false; error: string }>('ci:failedLog', path, id)
    logs.push(r.ok ? r.log : `(could not read the log of run ${id}: ${r.error})`)
  }
  const failingChecks = item.pr?.checks.filter((c) => c.state === 'failing').map((c) => c.name) ?? []
  const where = item.pr ? `pull request #${item.pr.number} "${item.pr.title}" (branch ${item.branch})` : `branch ${item.branch} (workflow "${item.run?.workflow}")`
  const otherBranch = item.branch !== status.branch
  const prompt = [
    `CI is failing on ${where}${failingChecks.length ? `; failing checks: ${failingChecks.join(', ')}` : ''}. ${item.url}`,
    logs.length ? `The failed steps' log ends like this:\n\`\`\`\n${logs.join('\n\n---\n\n')}\n\`\`\`` : 'Read the failure with `gh run view --log-failed`.',
    'Find the cause, fix it, and run the same checks locally until they pass.',
    otherBranch
      ? `Don't touch my current checkout (it is on ${status.branch}): add a git worktree for ${item.branch} in a temporary folder, work and push from there, then remove the worktree.`
      : `Then commit and push to ${item.branch}.`,
    "Never weaken, skip or delete a test to make it pass; if a test itself looks wrong, or the failure isn't in our code (an outage, a secret, a flaky runner), stop and tell me instead."
  ].join('\n\n')
  // a PR that an agent is already working on goes back to that agent
  const owner = item.pr ? ownerOf(item.branch) : null
  if (owner) {
    const note = `${prompt.replace(/\n\nDon't touch my current checkout[^\n]*|\n\nThen commit and push to [^\n]*/, '')}\n\nFix it on ${item.branch} and push.`
    if (owner.lead) await invoke('fleet:userMessage', owner.id, note)
    else sendToConsole(owner.id, note)
    fixers.set(item.key, owner.id)
    app.toast(`Sent the CI failure on PR #${item.pr!.number} to ${owner.name}`, 'info')
    return owner.id
  }
  const taken = allConsoles().map((c) => c.data.name as string)
  let name = 'CI fixer'
  for (let n = 2; taken.includes(name); n++) name = `CI fixer ${n}`
  const [id] = spawnConsoles({ names: [name], initialPrompt: prompt })
  if (!id) return null
  fixers.set(item.key, id)
  if (item.pr) setBranchAgent(item.branch, id)
  app.toast(opts.auto ? `CI failed, so ${name} is on it: ${item.label}` : `${name} is on it`, 'info')
  if (!opts.auto) window.setTimeout(() => useApp.getState().focusItem(id), 120)
  return id
}

export function setCiAutoFix(on: boolean) {
  useApp.getState().setProjectExtra('ciAutoFix', on || undefined)
}
