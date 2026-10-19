import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  ListTodo,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Sunrise,
  X
} from 'lucide-react'
import type { SweepRepo, SweepResult } from '../../../main/sweep'
import { invoke, on, runCli } from '../lib/api'
import { useApp } from '../state/store'
import { Modal } from '../ui/Modal'
import { runPlaybook } from '../playbooks/run'
import '../styles/sweep.css'

// Morning sweep: read-only health report across every repo (main/sweep.ts does the scanning).
// The last result is kept in memory so reopening the panel is instant; a stale one refreshes quietly.

let cache: SweepResult | null = null
let homeDir = ''
let briefCache: { at: number; text: string } | null = null
const STALE_MS = 3 * 60_000
const FAILING = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

const tilde = (p: string) => (homeDir && (p === homeDir || p.startsWith(homeDir + '/')) ? '~' + p.slice(homeDir.length) : p.replace(/^\/home\/[^/]+/, '~'))
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_m, x: string) => x.toLowerCase())
const agoText = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const failing = (r: SweepRepo) => !!r.ci && FAILING.has(r.ci.conclusion)
const dirtyCount = (r: SweepRepo) => r.uncommitted + r.untracked

function stats(res: SweepResult | null) {
  const repos = res?.repos ?? []
  return {
    scanned: repos.length,
    attention: repos.filter((r) => r.attention.length > 0).length,
    uncommitted: repos.filter((r) => dirtyCount(r) > 0).length,
    prs: repos.reduce((n, r) => n + r.prs.length, 0),
    failing: repos.filter(failing).length
  }
}

/** The sweep, trimmed to what a brief needs. */
function briefPayload(res: SweepResult) {
  return {
    scannedAt: new Date(res.at).toISOString(),
    fetchedRemotes: res.fetch,
    repos: res.repos.map((r) => ({
      name: r.name,
      branch: r.branch,
      defaultBranch: r.defaultBranch,
      ahead: r.ahead,
      behind: r.behind,
      uncommittedFiles: r.uncommitted,
      untrackedFiles: r.untracked,
      dirtyForDays: r.dirtySince ? Math.floor((Date.now() - r.dirtySince) / 86_400_000) : 0,
      stashes: r.stashes,
      lastCommit: r.lastCommit ? `${r.lastCommit.subject} (${r.lastCommit.relative})` : null,
      staleBranches: r.staleCount,
      openPrs: r.prs.map((p) => ({ number: p.number, title: p.title, draft: p.isDraft, review: p.reviewDecision || 'NONE', author: p.author })),
      ci: r.ci ? { conclusion: r.ci.conclusion || r.ci.status, workflow: r.ci.workflowName } : null,
      nextPlanItem: r.plan?.item ?? null,
      attention: r.attention,
      error: r.error ?? null
    }))
  }
}

export default function SweepPanel() {
  const [res, setRes] = useState<SweepResult | null>(cache)
  const [running, setRunning] = useState<null | 'scan' | 'fetch'>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; repo: string } | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [roots, setRoots] = useState('')
  const [rootsSaved, setRootsSaved] = useState('')
  const [brief, setBrief] = useState(briefCache && cache && briefCache.at === cache.at ? briefCache.text : '')
  const [briefing, setBriefing] = useState(false)
  const [briefErr, setBriefErr] = useState('')
  const [, tick] = useState(0)
  const cancelBrief = useRef<(() => void) | null>(null)
  const alive = useRef(true)
  const close = () => useApp.getState().closePanel()

  const scan = async (fetch = false) => {
    setRunning(fetch ? 'fetch' : 'scan')
    try {
      const r = await invoke<SweepResult>('sweep:run', { fetch })
      if (r.error && !r.repos.length) useApp.getState().toast(`Sweep failed: ${r.error}`, 'error')
      else cache = r
      if (alive.current) setRes(cache)
    } catch (e) {
      useApp.getState().toast(`Sweep failed: ${String((e as Error)?.message ?? e)}`, 'error')
    } finally {
      if (alive.current) {
        setRunning(null)
        setProgress(null)
      }
    }
  }

  useEffect(() => {
    alive.current = true
    const off = on('sweep:progress', (p: { done: number; total: number; repo: string }) => alive.current && setProgress(p))
    const t = window.setInterval(() => tick((n) => n + 1), 30_000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !useApp.getState().project && close()
    window.addEventListener('keydown', onKey)
    ;(async () => {
      if (!homeDir) homeDir = ((await invoke<{ home: string }>('app:paths').catch(() => null))?.home ?? '').replace(/\/+$/, '')
      const saved = await invoke('store:getGlobal', 'sweepRoots').catch(() => null)
      const list = Array.isArray(saved) ? saved.join(', ') : typeof saved === 'string' ? saved : ''
      if (!list) {
        const c = await invoke<{ roots: string[] }>('sweep:repos').catch(() => null)
        if (alive.current && c) setRoots(c.roots.join(', ')), setRootsSaved(c.roots.join(', '))
      } else if (alive.current) setRoots(list), setRootsSaved(list)
      if (!cache) {
        const last = await invoke<SweepResult | null>('sweep:last').catch(() => null)
        if (last) {
          cache = last
          if (alive.current) setRes(last)
        }
      }
      if (!cache || Date.now() - cache.at > STALE_MS) scan(false)
    })()
    return () => {
      alive.current = false
      off()
      window.clearInterval(t)
      window.removeEventListener('keydown', onKey)
      cancelBrief.current?.()
    }
  }, [])

  const saveRoots = async () => {
    const list = roots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const text = list.join(', ')
    setRoots(text)
    if (text === rootsSaved) return
    await invoke('store:setGlobal', 'sweepRoots', list)
    setRootsSaved(text)
    scan(false)
  }

  const briefMe = async () => {
    if (!res || briefing) return
    setBriefErr('')
    setBrief('')
    setBriefing(true)
    const prompt =
      'You are writing a short morning brief for a developer about their git repositories.\n' +
      'Below is a JSON health report from a read-only scan of every repo just now. Using ONLY this JSON, ' +
      'write 5-8 short lines of plain English: what needs attention first and why, in priority order ' +
      '(failing CI, PRs with changes requested or waiting on review, old uncommitted work, unpushed or behind branches, then cleanup). ' +
      'Name repos and PR numbers. End with one line on what can wait. No preamble, no headings, no tables. ' +
      'Do not use any tools or read files; everything you need is here.\n\n' +
      JSON.stringify(briefPayload(res))
    const run = runCli({ prompt, cwd: homeDir || '/' }, (_c, all) => alive.current && setBrief(all))
    cancelBrief.current = run.cancel
    try {
      const out = await run.promise
      if (!alive.current) return
      const text = (out.text || '').trim()
      if (out.code !== 0 && !text) setBriefErr('The CLI exited without a brief.')
      else {
        setBrief(text)
        briefCache = { at: res.at, text }
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (alive.current && msg !== 'cancelled') setBriefErr(msg)
    } finally {
      cancelBrief.current = null
      if (alive.current) setBriefing(false)
    }
  }

  const s = stats(res)
  const briefHtml = useMemo(() => (brief ? (marked.parse(brief, { async: false }) as string) : ''), [brief])
  const age = res ? Date.now() - res.at : 0

  const act = async (fn: () => Promise<unknown> | unknown, closeAfter = true) => {
    try {
      if (closeAfter) close()
      await fn()
    } catch (e) {
      useApp.getState().toast(String((e as Error)?.message ?? e), 'error')
    }
  }

  const progressText = progress
    ? progress.total
      ? `Checked ${progress.done} of ${progress.total}${progress.repo ? ` · ${progress.repo}` : ''}`
      : 'Finding repos…'
    : running === 'fetch'
      ? 'Fetching remotes…'
      : 'Scanning…'

  return (
    <Modal
      title="Morning sweep"
      sub="Read-only: nothing in your repos is changed."
      icon={<Sunrise size={17} />}
      width={980}
      height="84vh"
      bodyStyle={{ flex: 1, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      headerRight={
        <div className="row sw-head-actions">
          <button className="btn sm" disabled={!!running} onClick={() => scan(false)} title="Scan again (local only)">
            <RefreshCw size={13} className={running === 'scan' ? 'sw-spin' : ''} /> Refresh
          </button>
          <button
            className="btn sm"
            disabled={!!running}
            onClick={() => scan(true)}
            title="Runs git fetch in each repo. It contacts your git remotes and updates remote-tracking refs; your branches and files are untouched."
          >
            <CloudDownload size={13} className={running === 'fetch' ? 'sw-spin' : ''} /> Fetch remotes
          </button>
          {briefing ? (
            <button className="btn sm" onClick={() => cancelBrief.current?.()}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className="btn sm primary" disabled={!res?.repos.length} onClick={briefMe} title="Ask your CLI for a short plain-English brief of this sweep">
              <Sparkles size={13} /> Brief me
            </button>
          )}
        </div>
      }
      footer={
        <div className="sw-foot">
          <span className="label">Scan roots</span>
          <input
            className="input sw-roots mono"
            value={roots}
            spellCheck={false}
            placeholder="~/code, ~/Github, ~/projects"
            onChange={(e) => setRoots(e.target.value)}
            onBlur={saveRoots}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            title="Comma-separated folders. Repos up to two levels deep are scanned, plus your Fleetboard projects (max 40)."
          />
          <span className="spacer" />
          <span className="muted sw-foot-note">
            {res ? `last run ${clock(res.at)}${res.fetch ? ' · with fetch' : ''}` : 'not run yet'}
            {res && !res.ghAvailable ? ' · gh not found: no PR/CI data' : ''}
          </span>
        </div>
      }
    >
      <div className="sw-top">
        <div className="sw-stats">
          <Stat n={s.scanned} label="repos scanned" />
          <Stat n={s.attention} label="need attention" tone={s.attention ? 'warn' : 'ok'} />
          <Stat n={s.uncommitted} label="uncommitted work" tone={s.uncommitted ? 'warn' : undefined} />
          <Stat n={s.prs} label="open PRs" tone={s.prs ? 'accent' : undefined} />
          <Stat n={s.failing} label="failing CI" tone={s.failing ? 'danger' : 'ok'} />
        </div>
        <div className="sw-status muted">
          {running ? (
            <span className="sw-progress">
              <span className="sw-bar">
                <span style={{ width: progress?.total ? `${(progress.done / progress.total) * 100}%` : '8%' }} />
              </span>
              {progressText}
              {res && <span className="dim"> · showing results from {agoText(res.at)}</span>}
            </span>
          ) : res ? (
            age > 60_000 ? (
              <span>From {agoText(res.at)}</span>
            ) : (
              <span>Up to date</span>
            )
          ) : null}
          {running === 'fetch' || res?.fetch ? <span className="dim"> · fetch contacts your git remotes</span> : null}
        </div>
      </div>

      {(briefing || brief || briefErr) && (
        <div className="sw-brief">
          <div className="sw-brief-head">
            <Sparkles size={13} />
            <span className="label">Morning brief</span>
            {briefing && <span className="muted sw-brief-live">writing…</span>}
            <span className="spacer" />
            {!briefing && (
              <button className="icon-btn sm" title="Dismiss" onClick={() => (setBrief(''), setBriefErr(''), (briefCache = null))}>
                <X size={12} />
              </button>
            )}
          </div>
          {briefErr ? <div className="sw-brief-err">{briefErr}</div> : briefHtml ? <div className="md sw-brief-body" dangerouslySetInnerHTML={{ __html: briefHtml }} /> : <div className="muted">Reading the sweep…</div>}
        </div>
      )}

      <div className="sw-list scrollable no-board-wheel">
        {!res && running && <div className="empty sw-empty">{progressText}</div>}
        {res && !res.repos.length && !running && (
          <div className="empty sw-empty">No git repos found under {res.roots.join(', ')}. Edit the scan roots below.</div>
        )}
        {res?.repos.map((r) => (
          <RepoRow
            key={r.path}
            r={r}
            open={!!open[r.path]}
            onToggle={() => setOpen((o) => ({ ...o, [r.path]: !o[r.path] }))}
            onOpenBoard={() => act(() => useApp.getState().openProject(r.path))}
            onGreen={() => act(() => runPlaybook('get-green', {}, { projectPath: r.path }))}
            onPlan={() => act(() => runPlaybook('plan-next', r.plan ? { file: r.plan.file } : {}, { projectPath: r.path }))}
            onPrReview={() => act(() => runPlaybook('pr-review', {}, { projectPath: r.path }))}
          />
        ))}
      </div>
    </Modal>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: 'ok' | 'warn' | 'danger' | 'accent' }) {
  return (
    <div className={`sw-stat ${tone ? `t-${tone}` : ''}`}>
      <div className="sw-stat-n">{n}</div>
      <div className="sw-stat-l">{label}</div>
    </div>
  )
}

function level(r: SweepRepo) {
  if (r.error || failing(r) || r.score >= 30) return 'danger'
  if (r.attention.length) return 'warn'
  if (dirtyCount(r)) return 'busy'
  return 'ok'
}

function prState(p: SweepRepo['prs'][number]) {
  if (p.isDraft) return { text: 'draft', cls: '' }
  if (p.reviewDecision === 'CHANGES_REQUESTED') return { text: 'changes requested', cls: 't-danger' }
  if (p.reviewDecision === 'APPROVED') return { text: 'approved', cls: 't-ok' }
  return { text: 'needs review', cls: 't-warn' }
}

function RepoRow({
  r,
  open,
  onToggle,
  onOpenBoard,
  onGreen,
  onPlan,
  onPrReview
}: {
  r: SweepRepo
  open: boolean
  onToggle: () => void
  onOpenBoard: () => void
  onGreen: () => void
  onPlan: () => void
  onPrReview: () => void
}) {
  const lv = level(r)
  const dirty = dirtyCount(r)
  const ext = (url: string) => invoke('shell:openExternal', url)
  const repoUrl = r.slug ? `https://github.com/${r.slug}` : null
  const hasDetail = dirty > 0 || r.prs.length > 0 || r.staleBranches.length > 0 || !!r.ghError || !!r.fetchError || !!r.error || !!r.ci
  return (
    <div className={`sw-row lv-${lv} ${open ? 'open' : ''}`}>
      <div className="sw-row-main" onClick={onToggle}>
        <span className="sw-caret">{hasDetail ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
        <span className={`sw-lv lv-${lv}`} />
        <div className="sw-id grow">
          <div className="row sw-line1">
            <span className="sw-name">{r.name}</span>
            <span className="sw-branch mono">
              <GitBranch size={11} />
              {r.branch || '—'}
              {r.ahead > 0 && (
                <span className="sw-ab up" title={`${r.ahead} ahead of ${r.upstream}`}>
                  <ArrowUp size={10} />
                  {r.ahead}
                </span>
              )}
              {r.behind > 0 && (
                <span className="sw-ab down" title={`${r.behind} behind ${r.upstream}`}>
                  <ArrowDown size={10} />
                  {r.behind}
                </span>
              )}
              {!r.upstream && !r.detached && r.remoteUrl && <span className="dim sw-noup">no upstream</span>}
            </span>
            <span className="sw-path mono dim" title={r.path}>
              {tilde(r.path)}
            </span>
          </div>
          <div className="sw-chips">
            {dirty > 0 && <span className="pill t-warn">uncommitted {dirty}</span>}
            {r.prs.length > 0 && <span className="pill t-accent">PRs {r.prs.length}</span>}
            {r.ci && (
              <span
                className={`pill ${failing(r) ? 't-danger' : r.ci.conclusion === 'success' ? 't-ok' : ''}`}
                title={`${r.ci.workflowName}: ${r.ci.conclusion || r.ci.status} (${r.defaultBranch})`}
              >
                CI {failing(r) ? '✗' : r.ci.conclusion === 'success' ? '✓' : r.ci.conclusion ? r.ci.conclusion : '…'}
              </span>
            )}
            {r.staleCount > 0 && <span className="pill">stale branches {r.staleCount}</span>}
            {r.behind > 0 && <span className="pill t-warn">behind {r.behind}</span>}
            {r.stashes > 0 && <span className="pill">stash {r.stashes}</span>}
            {r.error && <span className="pill t-danger">error</span>}
          </div>
          {r.attention.length > 0 && (
            <div className="sw-attn">
              {r.attention.map((a, i) => (
                <div key={i}>{a}</div>
              ))}
            </div>
          )}
          <div className="sw-meta">
            {r.lastCommit ? (
              <span className="sw-commit" title={`${r.lastCommit.author} · ${new Date(r.lastCommit.time).toLocaleString()}`}>
                <span className="sw-subj">{r.lastCommit.subject}</span>
                <span className="dim"> · {r.lastCommit.relative}</span>
              </span>
            ) : (
              <span className="dim">No commits yet</span>
            )}
            {r.plan && (
              <span className="sw-plan" title={`Next in ${r.plan.file}`}>
                <ListTodo size={11} /> <span className="sw-plan-t">{r.plan.item}</span>
              </span>
            )}
          </div>
        </div>
        <div className="sw-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn sm" onClick={onOpenBoard} title="Open this repo's board">
            <LayoutDashboard size={12} /> Open board
          </button>
          <button className="btn sm ghost" onClick={onGreen} title="Playbook: run every check and fix until green">
            <ShieldCheck size={12} /> Get to green
          </button>
          {r.plan && (
            <button className="btn sm ghost" onClick={onPlan} title={`Playbook: build the next item in ${r.plan.file}`}>
              <ListTodo size={12} /> Next plan item
            </button>
          )}
          {r.prs.length > 0 && (
            <button className="btn sm ghost" onClick={onPrReview} title="Playbook: a reviewer per open PR (nothing posted to GitHub)">
              <GitPullRequest size={12} /> PR review
            </button>
          )}
        </div>
      </div>

      {open && hasDetail && (
        <div className="sw-detail">
          {r.error && <div className="sw-err">{r.error}</div>}
          {dirty > 0 && (
            <div className="sw-sec">
              <div className="label">
                Changes · {r.uncommitted} modified{r.untracked ? ` · ${r.untracked} untracked` : ''}
                {r.dirtySince ? <span className="sw-sec-note"> · oldest edit {agoText(r.dirtySince)}</span> : null}
              </div>
              <div className="sw-files mono">
                {r.files.map((f) => (
                  <div key={f.path} className="sw-file">
                    <span className={`sw-code c-${f.code === '??' ? 'q' : f.code[0]}`}>{f.code}</span>
                    <span className="sw-fpath">{f.path}</span>
                  </div>
                ))}
                {dirty > r.files.length && <div className="dim">+{dirty - r.files.length} more</div>}
              </div>
            </div>
          )}
          {r.prs.length > 0 && (
            <div className="sw-sec">
              <div className="label">Open pull requests</div>
              <div className="sw-prs">
                {r.prs.map((p) => {
                  const st = prState(p)
                  return (
                    <div key={p.number} className="sw-pr" onClick={() => ext(p.url)} title="Open on GitHub">
                      <span className="mono dim">#{p.number}</span>
                      <span className="sw-pr-t grow">{p.title}</span>
                      <span className="mono dim sw-pr-br">{p.headRefName}</span>
                      {p.author && <span className="dim">@{p.author}</span>}
                      <span className={`pill ${st.cls}`}>{st.text}</span>
                      <ExternalLink size={12} className="dim" />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {r.ci && (
            <div className="sw-sec">
              <div className="label">Latest CI on {r.defaultBranch}</div>
              <div className="sw-ci">
                <span className={failing(r) ? 't-danger' : r.ci.conclusion === 'success' ? 't-ok' : 'muted'}>{r.ci.conclusion || r.ci.status}</span>
                <span className="muted">{r.ci.workflowName}</span>
                {r.ci.createdAt && <span className="dim">{agoText(Date.parse(r.ci.createdAt))}</span>}
                {r.ci.url && (
                  <button className="btn sm ghost" onClick={() => ext(r.ci!.url)}>
                    <ExternalLink size={12} /> View run
                  </button>
                )}
              </div>
            </div>
          )}
          {r.staleBranches.length > 0 && (
            <div className="sw-sec">
              <div className="label">
                Stale branches{r.staleCount > r.staleBranches.length ? ` · showing ${r.staleBranches.length} of ${r.staleCount}` : ''}
              </div>
              <div className="sw-branches">
                {r.staleBranches.map((b) => (
                  <span key={b} className="sw-bname mono">
                    {b}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(r.ghError || r.fetchError) && (
            <div className="sw-sec">
              {r.fetchError && <div className="sw-err">Fetch: {r.fetchError}</div>}
              {r.ghError && <div className="sw-err">gh: {r.ghError}</div>}
            </div>
          )}
          {repoUrl && (
            <div className="sw-sec row">
              <button className="btn sm ghost" onClick={() => ext(repoUrl)}>
                <ExternalLink size={12} /> {r.slug} on GitHub
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
