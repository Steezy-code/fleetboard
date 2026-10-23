import { useState } from 'react'
import { Check, ExternalLink, FileText, MessageSquareText, RefreshCw, Send, Wrench } from 'lucide-react'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { Drawer, Switch } from '../ui/Modal'
import { CiIcon } from '../chrome/CiBadge'
import { ciItems, fixCi, fixerFor, refreshCi, setCiAutoFix, useCi, type CiItem } from '../workbench/ciStore'
import { agentMade, markSent, ownerOf, refreshFeedback, routeFeedback, setAutoRoute, unsent, useFeedback, type PrFeedback } from '../workbench/prFeedback'

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Right-side CI drawer: this branch's workflows, every open PR's checks and review comments, with "Fix it". */
export default function CiPanel() {
  const status = useCi((s) => s.status)
  const loading = useCi((s) => s.loading)
  const autoFix = useApp((s) => !!s.project?.extras.ciAutoFix)
  const autoRoute = useApp((s) => s.project?.extras.prAutoRoute !== false)
  const items = ciItems(status)
  const runs = items.filter((i) => i.run)
  const prs = items.filter((i) => i.pr)

  return (
    <Drawer
      title="CI & reviews"
      icon={<CiIcon state={status?.ok ? (runs.find((r) => r.state === 'failing') ? 'failing' : runs.find((r) => r.state === 'running') ? 'running' : runs.length ? 'passing' : 'none') : 'none'} size={14} />}
      width={400}
      headerRight={
        <button className="icon-btn sm" title="Check now" onClick={() => void Promise.all([refreshCi(), refreshFeedback()])}>
          <RefreshCw size={13} className={loading ? 'ci-spin' : ''} />
        </button>
      }
    >
      {!status ? (
        <div className="empty">Checking GitHub…</div>
      ) : !status.ok ? (
        <div className="empty">{status.error}</div>
      ) : (
        <div className="ci">
          <div className="ci-sec">
            <div className="label">
              This branch · <span className="mono">{status.branch}</span>
            </div>
            {runs.length ? runs.map((i) => <CiRow key={i.key} item={i} />) : <div className="muted small ci-none">No workflow runs on this branch yet.</div>}
          </div>
          <div className="ci-sec">
            <div className="label">Open pull requests</div>
            {prs.length ? prs.map((i) => <CiRow key={i.key} item={i} />) : <div className="muted small ci-none">No open pull requests.</div>}
          </div>
          <div className="ci-auto">
            <div className="grow">
              <div>Fix failures automatically</div>
              <div className="muted small">When a run turns red, start a CI fixer console with the failing log. It never weakens tests.</div>
            </div>
            <Switch on={autoFix} onChange={setCiAutoFix} />
          </div>
          <div className="ci-auto">
            <div className="grow">
              <div>Send review comments to the agent</div>
              <div className="muted small">New comments on a PR an agent made go straight to it (its Lead or console, or a new one in that branch). Other PRs only notify you.</div>
            </div>
            <Switch on={autoRoute} onChange={setAutoRoute} />
          </div>
          <div className="dim small ci-foot">
            {status.slug} · checked {ago(new Date(status.at).toISOString())} · every {runs.some((r) => r.state === 'running') || prs.some((p) => p.state === 'running') ? '20s while running' : 'minute'}
          </div>
        </div>
      )}
    </Drawer>
  )
}

function CiRow({ item }: { item: CiItem }) {
  const feedback = useFeedback((s) => (s.result?.ok && item.pr ? s.result.prs.find((p) => p.number === item.pr!.number) : undefined))
  const [log, setLog] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const path = useCi((s) => s.path)
  const fixer = fixerFor(item.key)
  const failingChecks = item.pr?.checks.filter((c) => c.state === 'failing') ?? []
  const sub = item.run
    ? `${item.run.title} · ${item.run.detail.replace(/_/g, ' ')} · ${ago(item.run.createdAt)}`
    : item.pr
      ? [
          item.pr.branch,
          item.pr.isDraft ? 'draft' : '',
          item.pr.checks.length ? (failingChecks.length ? `failing: ${failingChecks.map((c) => c.name).join(', ')}` : `${item.pr.checks.length} check${item.pr.checks.length === 1 ? '' : 's'}`) : 'no checks'
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  const showLog = async () => {
    if (log !== null) return setLog(null)
    setLog('Loading…')
    const parts = await Promise.all(
      item.runIds.slice(0, 3).map((id) => invoke<{ ok: true; log: string } | { ok: false; error: string }>('ci:failedLog', path, id).then((r) => (r.ok ? r.log : r.error)))
    )
    setLog(parts.join('\n\n---\n\n') || 'No log')
  }

  return (
    <div className={`ci-row ${item.state}`}>
      <div className="ci-row-top">
        <CiIcon state={item.state} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ci-row-title">{item.run ? item.run.workflow : `#${item.pr!.number} ${item.pr!.title}`}</div>
          <div className="ci-row-sub">{sub}</div>
        </div>
        <button className="icon-btn sm" title="Open on GitHub" onClick={() => invoke('shell:openExternal', item.url)}>
          <ExternalLink size={12} />
        </button>
      </div>
      {item.state === 'failing' && (
        <div className="ci-row-actions">
          <button
            className="btn sm primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await fixCi(item)
              setBusy(false)
            }}
          >
            <Wrench size={12} /> {fixer ? 'Go to the fixer' : busy ? 'Reading the log…' : 'Fix it'}
          </button>
          {item.runIds.length > 0 && (
            <button className="btn sm" onClick={showLog}>
              <FileText size={12} /> {log !== null ? 'Hide log' : 'Failed log'}
            </button>
          )}
        </div>
      )}
      {log !== null && <pre className="ci-log scrollable">{log}</pre>}
      {feedback && feedback.comments.length > 0 && <Feedback pr={feedback} />}
    </div>
  )
}

const WHERE = (c: PrFeedback['comments'][number]) =>
  c.kind === 'inline' ? `${c.path?.split('/').pop()}${c.line ? `:${c.line}` : ''}` : c.kind === 'review' ? (c.state === 'CHANGES_REQUESTED' ? 'changes requested' : 'review') : 'comment'

function Feedback({ pr }: { pr: PrFeedback }) {
  useApp((s) => s.project?.extras.prSent) // re-render when comments are sent
  useApp((s) => s.live)
  const [busy, setBusy] = useState(false)
  const fresh = unsent(pr)
  const owner = ownerOf(pr)
  const shown = (fresh.length ? fresh : pr.comments).slice(-3)
  const target = owner ? owner.name : 'a new console'
  return (
    <div className="ci-fb">
      <div className="ci-fb-head">
        <MessageSquareText size={12} />
        <span className="grow">
          {fresh.length ? `${fresh.length} new review comment${fresh.length === 1 ? '' : 's'}` : `${pr.comments.length} review comment${pr.comments.length === 1 ? '' : 's'}, all sent`}
          {agentMade(pr) ? ' · made by an agent' : ''}
        </span>
      </div>
      {shown.map((c) => (
        <button key={c.id} className={`ci-fb-item ${fresh.includes(c) ? 'new' : ''}`} title="Open on GitHub" onClick={() => invoke('shell:openExternal', c.url)}>
          <span className="ci-fb-who">
            @{c.author} · {WHERE(c)}
          </span>
          <span className="ci-fb-body">{c.body.replace(/\s+/g, ' ')}</span>
        </button>
      ))}
      <div className="ci-row-actions">
        <button
          className="btn sm primary"
          disabled={busy}
          title={`Send ${fresh.length ? 'the new' : 'all'} comments to ${target}`}
          onClick={async () => {
            setBusy(true)
            await routeFeedback(pr)
            setBusy(false)
          }}
        >
          <Send size={12} /> {fresh.length ? 'Send' : 'Send again'} to {target}
        </button>
        {fresh.length > 0 && (
          <button className="btn sm" title="Treat these as handled without sending them" onClick={() => markSent(pr, fresh)}>
            <Check size={12} /> Mark handled
          </button>
        )}
      </div>
    </div>
  )
}
