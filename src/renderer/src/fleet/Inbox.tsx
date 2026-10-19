import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, ChevronUp, GitMerge, Inbox as InboxIcon, MessageCircleQuestion, ShieldQuestion, SquareTerminal, Trash2, X } from 'lucide-react'
import { invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { agentColor, consoleTail } from '../engine/consoles'
import { useFleet } from '../engine/fleet'
import { parseApproval, type Approval } from './approvals'

/** Everything that needs the user, in one place: decisions, approvals, finished work. */
export function Inbox() {
  const project = useApp((s) => s.project)
  const blocked = useApp(useShallow((s) => Object.keys(s.statuses).filter((id) => s.statuses[id] === 'needs-you' && s.live[id])))
  const fleet = useFleet((s) => s.state)
  const [open, setOpen] = useState(true)
  const [approvals, setApprovals] = useState<Record<string, Approval | null>>({})

  // read each blocked console's prompt and keep it fresh
  useEffect(() => {
    if (!blocked.length) return setApprovals({})
    let live = true
    const read = async () => {
      const entries = await Promise.all(blocked.map(async (id) => [id, parseApproval(await consoleTail(id, 3000))] as const))
      if (live) setApprovals(Object.fromEntries(entries))
    }
    read()
    const t = window.setInterval(read, 1500)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [blocked.join(',')])

  const asks = (fleet?.asks ?? []).filter((a) => !a.answer)
  const ready = fleet?.ready ?? null
  const consoles = useMemo(() => Object.fromEntries(allConsoles().map((c) => [c.id, c])), [blocked.join(','), project])
  const count = asks.length + blocked.length + (ready ? 1 : 0)
  if (!project || !count) return null

  return (
    <div className="inbox" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <button className="inbox-head" onClick={() => setOpen(!open)}>
        <InboxIcon size={14} />
        <span>Inbox</span>
        <span className="inbox-count">{count}</span>
        <span className="spacer" />
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="inbox-body scrollable">
          {ready && <ReadyCard projectId={project.id} />}
          {asks.map((a) => (
            <AskCard key={a.id} id={a.id} from={fleet?.members[a.from]?.name ?? 'Lead'} question={a.question} options={a.options} />
          ))}
          {blocked.map((id) => {
            const c = consoles[id]
            const ap = approvals[id]
            return (
              <div key={id} className="inbox-card approval">
                <div className="ic-head">
                  <ShieldQuestion size={14} className="ic-icon warn" />
                  <span className="agent-dot" style={{ background: agentColor(c?.data.agentId ?? '') }} />
                  <b>{c?.data.name ?? 'Agent'}</b>
                  <span className="muted">{ap ? 'wants to' : 'is waiting for you'}</span>
                  <span className="spacer" />
                  <button className="icon-btn sm" title="Open console" onClick={() => openConsole(id)}>
                    <SquareTerminal size={13} />
                  </button>
                </div>
                {ap?.what && <pre className="ic-what">{ap.what}</pre>}
                <div className="ic-actions">
                  {ap ? (
                    ap.options.map((o) => (
                      <button key={o.key} className={`btn sm ${o.tone === 'allow' ? 'primary' : o.tone === 'deny' ? 'ghost' : ''}`} title={`Answers "${o.key}"`} onClick={() => answer(id, o.key)}>
                        {o.label}
                      </button>
                    ))
                  ) : (
                    <button className="btn sm" onClick={() => openConsole(id)}>
                      Open console
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function answer(consoleId: string, key: string) {
  if (key === 'trust' || key === 'exit') {
    // arrow-key menu that starts on "No, exit"
    if (key === 'trust') window.fb.send('pty:write', consoleId, '\x1b[B')
    window.setTimeout(() => window.fb.send('pty:write', consoleId, '\r'), 150)
    useApp.getState().setStatus(consoleId, 'working')
    return
  }
  window.fb.send('pty:write', consoleId, key)
  if (key === 'y' || key === 'n') window.setTimeout(() => window.fb.send('pty:write', consoleId, '\r'), 80)
  useApp.getState().setStatus(consoleId, 'working')
}

function openConsole(id: string) {
  const app = useApp.getState()
  const c = allConsoles().find((x) => x.id === id)
  if (!c) return
  if (c.workspaceId !== app.project?.activeWorkspaceId) app.switchWorkspace(c.workspaceId)
  window.setTimeout(() => useApp.getState().focusItem(id), 80)
}

function AskCard({ id, from, question, options }: { id: string; from: string; question: string; options: string[] }) {
  const [other, setOther] = useState('')
  const send = (a: string) => a.trim() && invoke('fleet:answer', id, a.trim())
  return (
    <div className="inbox-card ask">
      <div className="ic-head">
        <MessageCircleQuestion size={14} className="ic-icon" />
        <b>{from}</b>
        <span className="muted">asks</span>
      </div>
      <div className="ic-question">{question}</div>
      <div className="ic-actions wrap">
        {options.map((o, i) => (
          <button key={o} className={`btn sm ${i === 0 ? 'primary' : ''}`} onClick={() => send(o)}>
            {o}
          </button>
        ))}
      </div>
      <input
        className="input ic-other"
        placeholder="Or type your own answer…"
        value={other}
        onChange={(e) => setOther(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (send(other), setOther(''))}
      />
    </div>
  )
}

function ReadyCard({ projectId }: { projectId: string }) {
  const ready = useFleet((s) => s.state?.ready)!
  const lead = useFleet((s) => (ready ? s.state?.members[ready.leadId] : undefined))
  const [busy, setBusy] = useState<'' | 'merge' | 'discard'>('')
  const app = useApp.getState()
  if (!ready) return null

  const merge = async () => {
    setBusy('merge')
    const r = await invoke<{ ok: boolean; into?: string; error?: string }>('fleet:mergeReady', projectId)
    setBusy('')
    if (r.ok) app.toast(r.into ? `Merged into ${r.into}. The team is dismissed.` : 'Done. The team is dismissed.', 'ok')
    else app.toast(`Merge failed: ${r.error}`, 'error')
  }
  const discard = async () => {
    if (!(await app.confirm({ title: 'Discard the team’s work?', body: `Deletes branch ${ready.branch} and closes the team’s consoles.`, confirm: 'Discard', danger: true }))) return
    setBusy('discard')
    await invoke('fleet:discard', projectId)
    setBusy('')
  }
  return (
    <div className="inbox-card ready">
      <div className="ic-head">
        <Check size={14} className="ic-icon ok" />
        <b>Ready to merge</b>
        <span className="muted">from {lead?.name ?? 'Lead'}</span>
      </div>
      {lead?.task && <div className="ic-goal">“{lead.task}”</div>}
      <div className="ic-summary">{ready.summary}</div>
      {ready.branch && (
        <div className="ic-meta mono">
          {ready.branch} · {ready.commits} commit{ready.commits === 1 ? '' : 's'} · {ready.files.length} file{ready.files.length === 1 ? '' : 's'}
        </div>
      )}
      <div className="ic-actions">
        <button className="btn sm primary" disabled={!!busy} onClick={merge}>
          <GitMerge size={13} /> {busy === 'merge' ? 'Merging…' : ready.branch ? 'Merge' : 'Done'}
        </button>
        {ready.branch && (
          <button className="btn sm" onClick={() => app.openPanel('fleetDiff', { projectId })}>
            Show diff
          </button>
        )}
        <span className="spacer" />
        <button className="icon-btn sm" title="Discard" disabled={!!busy} onClick={discard}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

/** Diff of the team's branch, for the Ready card. */
export function FleetDiffPanel({ projectId }: { projectId: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  useEffect(() => {
    invoke<string>('fleet:diff', projectId).then(setDiff)
  }, [projectId])
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && useApp.getState().closePanel()}>
      <div className="modal" style={{ width: 'min(1100px, 94vw)', height: '84vh' }}>
        <div className="modal-head">
          <div className="grow">
            <div className="modal-title">Team changes</div>
            <div className="modal-sub">Everything the team will merge into your branch.</div>
          </div>
          <button className="icon-btn" onClick={() => useApp.getState().closePanel()}>
            <X size={16} />
          </button>
        </div>
        <pre className="fleet-diff scrollable">
          {diff === null
            ? 'Loading…'
            : diff.split('\n').map((l, i) => (
                <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'file' : ''}>
                  {l + '\n'}
                </span>
              ))}
        </pre>
      </div>
    </div>
  )
}
