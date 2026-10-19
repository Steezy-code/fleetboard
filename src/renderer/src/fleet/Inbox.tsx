import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, ChevronUp, GitMerge, GitPullRequestArrow, Inbox as InboxIcon, MessageCircleQuestion, ShieldQuestion, SquareTerminal, Trash2, X } from 'lucide-react'
import { invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { agentColor } from '../engine/consoles'
import { useFleet } from '../engine/fleet'
import { approvalFor, type Approval } from './approvals'
import type { AnswerResult, Prompt, PromptAnswer } from '@shared/prompt'

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
      const entries = await Promise.all(blocked.map(async (id) => [id, approvalFor(await invoke<Prompt | null>('pty:prompt', id).catch(() => null))] as const))
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
  // a lead whose console exited mid-task: the team has nobody to merge or finish
  const exited = useApp(useShallow((s) => Object.keys(s.statuses).filter((id) => s.statuses[id] === 'exited')))
  const stoppedLeads = Object.values(fleet?.members ?? {}).filter((m) => m.role === 'lead' && (m.status === 'working' || m.status === 'starting') && exited.includes(m.id))
  const consoles = useMemo(() => Object.fromEntries(allConsoles().map((c) => [c.id, c])), [blocked.join(','), project])
  const count = asks.length + blocked.length + stoppedLeads.length + (ready ? 1 : 0)
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
          {stoppedLeads.map((m) => (
            <div key={m.id} className="inbox-card approval stopped">
              <div className="ic-head">
                <ShieldQuestion size={14} className="ic-icon warn" />
                <b>{m.name}</b>
                <span className="muted">stopped before finishing</span>
              </div>
              <div className="ic-title">Its console exited. Resume it on its tile to carry on (it is told where the team is), or discard the team’s work.</div>
              <div className="ic-actions">
                <button className="btn sm primary" onClick={() => openConsole(m.id)}>
                  <SquareTerminal size={13} /> Open console
                </button>
                <button className="btn sm ghost" onClick={() => discardTeam(project.id, m.id)}>
                  <Trash2 size={13} /> Discard team
                </button>
              </div>
            </div>
          ))}
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
                  <span className="muted">{ap ? 'asks' : 'is waiting for you'}</span>
                  <span className="spacer" />
                  <button className="icon-btn sm" title="Open console" onClick={() => openConsole(id)}>
                    <SquareTerminal size={13} />
                  </button>
                </div>
                {ap?.title && <div className="ic-title">{ap.title}</div>}
                {ap?.detail && <pre className="ic-what">{ap.detail}</pre>}
                <div className="ic-actions">
                  {ap ? (
                    ap.options.map((o) => (
                      <button key={o.label} className={`btn sm ${o.tone === 'allow' ? 'primary' : o.tone === 'deny' ? 'ghost' : ''}`} title={'option' in o.answer ? o.answer.option : undefined} onClick={() => answer(id, o.answer)}>
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

async function answer(consoleId: string, a: PromptAnswer) {
  const res = await invoke<AnswerResult>('pty:answer', consoleId, a).catch((): AnswerResult => ({ ok: false, reason: 'not-live' }))
  if (res.ok) return useApp.getState().setStatus(consoleId, 'working')
  // the prompt was answered in the terminal, or turned into another question: nothing was typed
  useApp.getState().toast(res.reason === 'not-live' ? 'That console has stopped' : 'That question changed; nothing was sent. Check the console.', 'warn')
}

async function discardTeam(projectId: string, leadId: string) {
  const app = useApp.getState()
  if (!(await app.confirm({ title: 'Discard the team’s work?', body: 'Deletes the team’s branches and worktrees and closes its consoles.', confirm: 'Discard', danger: true }))) return
  await invoke('fleet:discard', projectId, leadId)
}

function openConsole(id: string) {
  const app = useApp.getState()
  const c = allConsoles().find((x) => x.id === id)
  if (!c) return
  if (c.workspaceId !== app.project?.activeWorkspaceId) app.switchWorkspace(c.workspaceId)
  // dive into it full screen; Back returns to wherever you were
  window.setTimeout(() => useApp.getState().enterFocus(id), 80)
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
  const [busy, setBusy] = useState<'' | 'merge' | 'discard' | 'pr' | 'done'>('')
  const app = useApp.getState()
  if (!ready) return null

  const merge = async () => {
    setBusy('merge')
    const r = await invoke<{ ok: boolean; into?: string; error?: string }>('fleet:mergeReady', projectId)
    setBusy('')
    if (r.ok) app.toast(r.into ? `Merged into ${r.into}. The team is dismissed.` : 'Done. The team is dismissed.', 'ok')
    else app.toast(`Merge failed: ${r.error}`, 'error')
  }
  const openPr = async () => {
    if (!(await app.confirm({ title: 'Push this branch and open a draft PR?', body: `Pushes ${ready.branch} to origin and opens a draft pull request with the team's summary as its description.`, confirm: 'Open draft PR' }))) return
    setBusy('pr')
    const r = await invoke<{ ok: boolean; url?: string; error?: string }>('fleet:openPr', projectId)
    setBusy('')
    if (r.ok) {
      app.toast('Draft PR opened', 'ok')
      if (r.url) invoke('shell:openExternal', r.url)
    } else app.toast(r.error ?? 'Could not open the PR', 'error')
  }
  const finish = async () => {
    setBusy('done')
    await invoke('fleet:done', projectId)
    setBusy('')
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
      {ready.prUrl && (
        <button className="ic-pr mono" onClick={() => invoke('shell:openExternal', ready.prUrl)}>
          <GitPullRequestArrow size={12} /> {ready.prUrl.replace(/^https:\/\/github.com\//, '')}
        </button>
      )}
      <div className="ic-actions">
        {/* a report-only run (no commits) or an opened PR just closes the team */}
        {!ready.branch || ready.commits === 0 || ready.prUrl ? (
          <button className="btn sm primary" disabled={!!busy} onClick={finish}>
            <Check size={13} /> {busy === 'done' ? 'Closing…' : 'Done'}
          </button>
        ) : (
          <button className="btn sm primary" disabled={!!busy} onClick={merge}>
            <GitMerge size={13} /> {busy === 'merge' ? 'Merging…' : 'Merge'}
          </button>
        )}
        {ready.branch && ready.commits > 0 && ready.hasRemote && !ready.prUrl && (
          <button className="btn sm" disabled={!!busy} onClick={openPr}>
            <GitPullRequestArrow size={13} /> {busy === 'pr' ? 'Opening…' : 'Open draft PR'}
          </button>
        )}
        {ready.branch && ready.commits > 0 && (
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
