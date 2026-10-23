import { useEffect, useMemo, useRef, useState } from 'react'
import { plural } from '../orchestration/fleet'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  History,
  Loader2,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { git, refreshGit, useGitStatus, type GitBranch as Branch, type GitCommit, type GitFile, type GitPr, type GitRemote } from './gitStore'
import { GithubMark } from './icons'
import { baseName, dirname, midTruncate } from './paths'

type Busy = '' | 'commit' | 'push' | 'pull' | 'fetch' | 'init' | 'checkout'

type Viewer = { kind: 'file'; file: GitFile } | { kind: 'commit'; commit: GitCommit }

const STATUS_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflict',
  '?': 'Untracked'
}

const toast = (text: string, tone?: 'info' | 'warn' | 'error' | 'ok') => useApp.getState().toast(text, tone)

function defaultMessage(files: GitFile[]) {
  const [f] = files
  if (files.length === 1 && f) {
    const verb = f.code === 'A' || f.code === '?' ? 'Add' : f.code === 'D' ? 'Remove' : f.code === 'R' ? 'Rename' : 'Update'
    return `${verb} ${baseName(f.path)}`
  }
  return `Update ${files.length} files`
}

/** Shared git UI: the git card node and the git drawer both render this. */
export function GitView({ cwd, variant }: { cwd: string; variant: 'node' | 'drawer' }) {
  const entry = useGitStatus(cwd)
  const st = entry.status
  const [remote, setRemote] = useState<GitRemote | null>(null)
  // null until the first log arrives, so an unloaded list never reads as "No commits yet"
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [history, setHistory] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<Busy>('')
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [prsOpen, setPrsOpen] = useState(false)

  // remote (once per repo, and after init)
  useEffect(() => {
    if (!entry.isRepo) return
    let alive = true
    git<{ remote: GitRemote }>('remote', cwd).then((r) => alive && r.ok && setRemote(r.remote))
    return () => {
      alive = false
    }
  }, [cwd, entry.isRepo])

  // recent commits follow the status (new commit, push, pull all change it)
  const n = history ? 60 : 6
  useEffect(() => {
    if (!entry.isRepo) return
    let alive = true
    git<{ commits: GitCommit[] }>('log', cwd, n).then((r) => alive && r.ok && setCommits(r.commits))
    return () => {
      alive = false
    }
  }, [cwd, entry.isRepo, entry.version, n])

  const files = st?.files ?? []
  const selected = useMemo(() => files.filter((f) => !excluded.has(f.path)), [files, excluded])
  const allSelected = selected.length === files.length
  const canPush = !!remote?.url

  // forget exclusions for files that are gone
  useEffect(() => {
    if (!excluded.size) return
    const present = new Set(files.map((f) => f.path))
    const next = new Set([...excluded].filter((p) => present.has(p)))
    if (next.size !== excluded.size) setExcluded(next)
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // close the diff viewer when its file is committed away
  useEffect(() => {
    if (viewer?.kind === 'file' && !files.some((f) => f.path === viewer.file.path)) setViewer(null)
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (p: string) =>
    setExcluded((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  async function commitAndPush() {
    if (!selected.length || busy) return
    const msg = message.trim() || defaultMessage(selected)
    setBusy('commit')
    const c = await git<{ hash: string }>('commit', cwd, msg, allSelected ? null : selected.map((f) => ({ path: f.path, from: f.from })))
    if (!c.ok) {
      toast(c.error, 'error')
      setBusy('')
      return
    }
    setMessage('')
    setExcluded(new Set())
    if (canPush) {
      setBusy('push')
      const p = await git('push', cwd)
      if (p.ok) toast(`Committed and pushed ${plural(selected.length, 'file')} · ${c.hash}`, 'ok')
      else toast(`Committed ${c.hash}, but push failed: ${p.error}`, 'error')
    } else toast(`Committed ${plural(selected.length, 'file')} · ${c.hash}`, 'ok')
    await refreshGit(cwd)
    setBusy('')
  }

  async function run(kind: 'push' | 'pull' | 'fetch', okText: string) {
    if (busy) return
    setBusy(kind)
    const r = await git<{ output?: string }>(kind, cwd)
    if (r.ok) {
      if (kind !== 'fetch') toast(okText, 'ok')
    } else toast(r.error, 'error')
    await refreshGit(cwd)
    setBusy('')
  }

  async function refresh() {
    await refreshGit(cwd)
    git<{ remote: GitRemote }>('remote', cwd).then((r) => r.ok && setRemote(r.remote))
    if (canPush) run('fetch', '')
  }

  async function init() {
    setBusy('init')
    const r = await git('init', cwd)
    if (r.ok) toast('Initialized a git repository', 'ok')
    else toast(r.error, 'error')
    await refreshGit(cwd)
    setBusy('')
  }

  const wrapCls = `gv gv-${variant}${variant === 'node' ? ' scrollable no-board-wheel' : ''}`

  if (!st) {
    if (entry.isRepo === false)
      return (
        <div className={wrapCls}>
          <div className="gv-empty">
            <FolderGit2 size={26} className="dim" />
            <div className="gv-empty-title">Not a git repository</div>
            <div className="dim small mono gv-path">{cwd}</div>
            <button className="btn primary sm" onClick={init} disabled={busy === 'init'}>
              {busy === 'init' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Initialize repository
            </button>
          </div>
        </div>
      )
    return (
      <div className={wrapCls}>
        <div className="gv-empty">
          <Loader2 size={18} className="spin dim" />
          <div className="dim small">{entry.error ?? 'Reading repository…'}</div>
        </div>
      </div>
    )
  }

  const slug = remote?.slug ?? baseName(st.root)
  const web = remote?.web

  return (
    <div className={wrapCls}>
      <div className="gv-head">
        <span className="gv-gh">
          <GithubMark size={15} />
        </span>
        <span className="gv-slug" title={remote?.url ?? st.root}>
          {midTruncate(slug, variant === 'node' ? 24 : 28)}
        </span>
        <span className="spacer" />
        <button className="icon-btn sm" title="Refresh (and fetch)" onClick={refresh}>
          <RefreshCw size={13} className={busy === 'fetch' || entry.loading ? 'spin' : ''} />
        </button>
        {web && (
          <button className="icon-btn sm" title="Open on the web" onClick={() => invoke('shell:openExternal', st.detached ? web : `${web}/tree/${encodeURIComponent(st.branch)}`)}>
            <ExternalLink size={13} />
          </button>
        )}
        <button className="icon-btn sm" title={st.upstream ? `Pull from ${st.upstream}` : 'No upstream to pull from'} disabled={!st.upstream || !!busy} onClick={() => run('pull', 'Pulled latest changes')}>
          {busy === 'pull' ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}
        </button>
      </div>

      <div className="gv-branchrow">
        <div className="gv-branch-wrap">
          <button className="gv-branch" onClick={() => setBranchMenu((v) => !v)} title="Switch branch">
            <GitBranch size={12} />
            <span className="mono">{st.branch}</span>
            <ChevronDown size={11} className="dim" />
          </button>
          {branchMenu && <BranchMenu cwd={cwd} current={st.branch} dirty={files.length > 0} onClose={() => setBranchMenu(false)} setBusy={setBusy} />}
        </div>
        {st.ahead > 0 && (
          <span className="gv-ab" title={`${plural(st.ahead, 'commit')} to push`}>
            ↑{st.ahead}
          </span>
        )}
        {st.behind > 0 && (
          <span className="gv-ab behind" title={`${plural(st.behind, 'commit')} to pull`}>
            ↓{st.behind}
          </span>
        )}
        <span className="dim small gv-up">{st.upstream ?? (canPush ? 'not published' : 'local only')}</span>
      </div>

      {/* ---------- changes ---------- */}
      <div className="gv-section">
        <div className="gv-sec-head">
          <span className="label">Changes</span>
          {files.length > 0 && <span className="gv-count">{files.length}</span>}
          <span className="spacer" />
          {files.length > 1 && (
            <button className="gv-link" onClick={() => setExcluded(allSelected ? new Set(files.map((f) => f.path)) : new Set())}>
              {allSelected ? 'Select none' : 'Select all'}
            </button>
          )}
        </div>

        {files.length === 0 ? (
          <div className="gv-clean">
            <span className="gv-clean-ic">
              <CircleCheck size={16} />
            </span>
            <div className="grow">
              <div>Working tree clean</div>
              <div className="dim small">
                {st.ahead > 0 ? `${plural(st.ahead, 'commit')} not pushed yet` : st.behind > 0 ? `${plural(st.behind, 'commit')} behind ${st.upstream}` : 'Nothing to commit'}
              </div>
            </div>
            {st.ahead > 0 && canPush && (
              <button className="btn sm" disabled={!!busy} onClick={() => run('push', `Pushed ${plural(st.ahead, 'commit')}`)}>
                {busy === 'push' ? <Loader2 size={12} className="spin" /> : <ArrowUpFromLine size={12} />} Push
              </button>
            )}
            {st.ahead === 0 && st.behind > 0 && (
              <button className="btn sm" disabled={!!busy} onClick={() => run('pull', 'Pulled latest changes')}>
                {busy === 'pull' ? <Loader2 size={12} className="spin" /> : <ArrowDownToLine size={12} />} Pull
              </button>
            )}
          </div>
        ) : (
          <>
            <div className={`gv-files ${variant === 'drawer' ? 'scrollable' : ''}`}>
              {files.map((f) => {
                const on = !excluded.has(f.path)
                const name = baseName(f.path) + (f.path.endsWith('/') ? '/' : '')
                const dir = f.path.includes('/') && !/^[^/]+\/$/.test(f.path) ? dirname(f.path.replace(/\/$/, '')) : ''
                const active = viewer?.kind === 'file' && viewer.file.path === f.path
                return (
                  <div key={f.path} className={`gv-file ${active ? 'active' : ''} ${on ? '' : 'off'}`} onClick={() => setViewer(active ? null : { kind: 'file', file: f })}>
                    <button
                      className={`gv-check ${on ? 'on' : ''}`}
                      title={on ? 'Leave out of the commit' : 'Include in the commit'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(f.path)
                      }}
                    >
                      {on && <Check size={10} strokeWidth={3} />}
                    </button>
                    <span className={`gv-code c-${f.code === '?' ? 'u' : f.code}`} title={STATUS_LABEL[f.code] ?? f.code}>
                      {f.code}
                    </span>
                    <span className="gv-name" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                      {name}
                    </span>
                    {dir && <span className="gv-dir">{dir}</span>}
                  </div>
                )
              })}
            </div>
            {viewer?.kind === 'file' && <DiffViewer cwd={cwd} viewer={viewer} onClose={() => setViewer(null)} />}
            <div className="gv-commit">
              <input
                className="input gv-msg"
                value={message}
                placeholder={selected.length ? defaultMessage(selected) : 'Select files to commit'}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitAndPush()
                  }
                }}
                disabled={busy === 'commit' || busy === 'push'}
              />
              <button className="btn primary gv-commit-btn" disabled={!selected.length || !!busy} onClick={commitAndPush}>
                {busy === 'commit' ? (
                  <>
                    <Loader2 size={13} className="spin" /> Committing…
                  </>
                ) : busy === 'push' ? (
                  <>
                    <Loader2 size={13} className="spin" /> Pushing…
                  </>
                ) : (
                  <>
                    <ArrowUpFromLine size={13} /> {canPush ? 'Commit & Push' : 'Commit'} {plural(selected.length, 'file')}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ---------- recent / history ---------- */}
      <div className="gv-section">
        <div className="gv-sec-head">
          <span className="label">{history ? 'History' : 'Recent'}</span>
          <span className="spacer" />
          <button className={`gv-link ${history ? 'on' : ''}`} onClick={() => setHistory((v) => !v)} title="Show full history">
            <History size={11} /> {history ? 'Less' : 'History'}
          </button>
        </div>
        {commits === null ? (
          <div className="dim small gv-none">Loading…</div>
        ) : commits.length === 0 ? (
          <div className="dim small gv-none">No commits yet</div>
        ) : (
          <div className={`gv-commits ${history && variant === 'drawer' ? 'scrollable' : ''}`}>
            {commits.map((c) => {
              const active = viewer?.kind === 'commit' && viewer.commit.hash === c.hash
              return (
                <div key={c.hash}>
                  <div className={`gv-c ${active ? 'active' : ''}`} onClick={() => setViewer(active ? null : { kind: 'commit', commit: c })} title={`${c.subject}\n${c.author} · ${c.date}`}>
                    <span className={`gv-c-dot ${c.pushed ? 'pushed' : ''}`} title={c.pushed ? 'Pushed' : 'Not pushed'} />
                    <span className="gv-c-subj">{c.subject}</span>
                    <span className="gv-c-meta">
                      {history && <span className="gv-c-author">{c.author} · </span>}
                      {c.date}
                    </span>
                    <span className="gv-c-hash mono">{c.short}</span>
                  </div>
                  {active && <DiffViewer cwd={cwd} viewer={viewer!} onClose={() => setViewer(null)} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {variant === 'drawer' && remote?.web?.includes('github.com') && (
        <div className="gv-section">
          <button className="gv-sec-head gv-sec-toggle" onClick={() => setPrsOpen((v) => !v)}>
            {prsOpen ? <ChevronDown size={12} className="dim" /> : <ChevronRight size={12} className="dim" />}
            <span className="label">Pull requests</span>
          </button>
          {prsOpen && <PrList cwd={cwd} />}
        </div>
      )}
    </div>
  )
}

// ---------- diff viewer ----------

function DiffViewer({ cwd, viewer, onClose }: { cwd: string; viewer: Viewer; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = viewer.kind === 'file' ? `f:${viewer.file.path}:${viewer.file.x}${viewer.file.y}` : `c:${viewer.commit.hash}`
  useEffect(() => {
    let alive = true
    setText(null)
    setError(null)
    const p =
      viewer.kind === 'file'
        ? git<{ diff: string }>('diff', cwd, viewer.file.path, { untracked: viewer.file.untracked })
        : git<{ diff: string }>('show', cwd, viewer.commit.hash)
    p.then((r) => {
      if (!alive) return
      if (r.ok) setText(r.diff)
      else setError(r.error)
    })
    return () => {
      alive = false
    }
  }, [cwd, key]) // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => (text ?? '').split('\n').slice(0, 4000), [text])
  const title = viewer.kind === 'file' ? viewer.file.path : `${viewer.commit.short} · ${viewer.commit.subject}`
  return (
    <div className="gdiff" onClick={(e) => e.stopPropagation()}>
      <div className="gdiff-head">
        <span className="mono gdiff-title" title={title}>
          {title}
        </span>
        <button className="icon-btn sm" onClick={onClose} title="Close diff">
          <X size={12} />
        </button>
      </div>
      <div className="gdiff-body scrollable no-board-wheel">
        {error ? (
          <div className="gdiff-msg">{error}</div>
        ) : text == null ? (
          <div className="gdiff-msg">
            <Loader2 size={13} className="spin" />
          </div>
        ) : (
          <pre className="gdiff-pre">
            {lines.map((l, i) => {
              const cls =
                l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git') || l.startsWith('index ')
                  ? 'meta'
                  : l.startsWith('+')
                    ? 'add'
                    : l.startsWith('-')
                      ? 'del'
                      : l.startsWith('@@')
                        ? 'hunk'
                        : ''
              return (
                <div key={i} className={`gdl ${cls}`}>
                  {l || ' '}
                </div>
              )
            })}
          </pre>
        )}
      </div>
    </div>
  )
}

// ---------- branch menu ----------

function BranchMenu({
  cwd,
  current,
  dirty,
  onClose,
  setBusy
}: {
  cwd: string
  current: string
  dirty: boolean
  onClose: () => void
  setBusy: (b: Busy) => void
}) {
  const [list, setList] = useState<Branch[] | null>(null)
  const [name, setName] = useState('')
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    git<{ branches: Branch[] }>('branches', cwd).then((r) => setList(r.ok ? r.branches : []))
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.gv-branch')) onClose()
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  async function go(branch: string, create = false) {
    onClose()
    if (!create && branch === current) return
    setBusy('checkout')
    const r = await git('checkout', cwd, branch, create)
    if (r.ok) toast(create ? `Created and switched to ${branch}` : `Switched to ${branch}`, 'ok')
    else toast(r.error, 'error')
    await refreshGit(cwd)
    setBusy('')
  }

  const shown = (list ?? []).filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="menu gv-bmenu" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      {(list?.length ?? 0) > 8 && <input className="input gv-bq" autoFocus placeholder="Filter branches" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="gv-blist scrollable no-board-wheel">
        {list == null ? (
          <div className="menu-label dim small">Loading…</div>
        ) : (
          shown.map((b) => (
            <button key={b.name} className={`menu-item ${b.current ? 'on' : ''}`} onClick={() => go(b.name)}>
              <span className="ic">{b.current ? <Check size={13} /> : <GitBranch size={13} />}</span>
              <span className="grow mono gv-bname">{b.name}</span>
              <span className="dim small">{b.date}</span>
            </button>
          ))
        )}
      </div>
      <div className="menu-sep" />
      {dirty && <div className="menu-label dim small">Uncommitted changes move with you.</div>}
      <div className="row" style={{ padding: '2px 4px 4px' }}>
        <input
          className="input gv-bnew"
          placeholder="New branch name"
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && go(name.trim(), true)}
        />
        <button className="btn sm" disabled={!name.trim()} onClick={() => go(name.trim(), true)}>
          <Plus size={12} /> Create
        </button>
      </div>
    </div>
  )
}

// ---------- pull requests (gh) ----------

function PrList({ cwd }: { cwd: string }) {
  const [prs, setPrs] = useState<GitPr[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    git<{ prs: GitPr[] }>('prList', cwd).then((r) => (r.ok ? setPrs(r.prs) : setError(r.error)))
  }, [cwd])
  if (error) return <div className="dim small gv-none">{error}</div>
  if (!prs)
    return (
      <div className="gv-none">
        <Loader2 size={13} className="spin dim" />
      </div>
    )
  if (!prs.length) return <div className="dim small gv-none">No open pull requests</div>
  return (
    <div className="gv-commits">
      {prs.map((p) => (
        <div key={p.number} className="gv-c" onClick={() => invoke('shell:openExternal', p.url)} title={p.title}>
          <GitPullRequest size={12} style={{ color: p.isDraft ? 'var(--dim)' : 'var(--ok)', flex: 'none' }} />
          <span className="gv-c-subj">{p.title}</span>
          <span className="gv-c-meta mono">{p.headRefName}</span>
          <span className="gv-c-hash mono">#{p.number}</span>
        </div>
      ))}
    </div>
  )
}
