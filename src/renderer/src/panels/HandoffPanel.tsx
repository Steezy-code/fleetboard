import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../workbench/markdown'
import { ArrowRight, Check, RefreshCw, Send, Square } from 'lucide-react'
import { useApp } from '../state/store'
import { agentColor, agentLabel } from '../engine/consoles'
import { handoff, writeBrief } from '../engine/handoff'
import { Modal, Seg } from '../ui/Modal'
import { STATUS_TEXT, statusOf, useFleet, useInstalledAgents } from '../orchestration/fleet'
import { AgentAvatar } from '../orchestration/OrchestratorView'

type Mode = 'agent' | 'console'

/** Pass a task on: summarize the source sessions into a brief and type it into another agent. */
export default function HandoffPanel({ from, toAgentId: initialAgent }: { from?: string[]; toAgentId?: string }) {
  const fleet = useFleet()
  const statuses = useApp((s) => s.statuses)
  const live = useApp((s) => s.live)
  const installed = useInstalledAgents()
  const [sources, setSources] = useState<string[]>(() => from ?? useApp.getState().selection.filter((id) => fleet.consoles.some((c) => c.id === id)))
  const firstAgent = fleet.consoles.find((c) => c.id === sources[0])?.agentId
  const defaultTarget =
    initialAgent && installed.includes(initialAgent)
      ? initialAgent
      : installed.find((a) => a !== firstAgent && a !== 'shell') ?? installed.find((a) => a !== 'shell') ?? 'shell'
  const [mode, setMode] = useState<Mode>('agent')
  const [toAgent, setToAgent] = useState(defaultTarget)
  const [toIds, setToIds] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [brief, setBrief] = useState('')
  const [phase, setPhase] = useState<'idle' | 'writing' | 'ready' | 'sending'>('idle')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cancelRef.current?.(), [])

  const others = fleet.consoles.filter((c) => !sources.includes(c.id))
  // the brief is an agent's streamed output: it goes through the app's one allowlist sanitizer.
  // marked has no sanitizer of its own, and this re-renders on every chunk, so raw HTML here used
  // to run mid-stream.
  const html = useMemo(() => (brief ? renderMarkdown(brief) : ''), [brief])

  const generate = async () => {
    if (!sources.length) return
    setError('')
    setBrief('')
    setEditing(false)
    setPhase('writing')
    let got = ''
    const run = writeBrief(sources, note.trim() || undefined, (all) => ((got = all), setBrief(all)))
    cancelRef.current = run.cancel
    try {
      const text = await run.promise
      setBrief(text)
      setPhase('ready')
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg !== 'cancelled') setError(msg)
      setPhase(got.trim() ? 'ready' : 'idle')
    } finally {
      cancelRef.current = null
    }
  }

  const stop = () => {
    cancelRef.current?.()
    cancelRef.current = null
    setPhase(brief.trim() ? 'ready' : 'idle')
  }

  const send = async () => {
    setError('')
    let text = brief.trim()
    if (!text) {
      setPhase('writing')
      const run = writeBrief(sources, note.trim() || undefined, (all) => setBrief(all))
      cancelRef.current = run.cancel
      try {
        text = await run.promise
        setBrief(text)
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
        setPhase('idle')
        return
      } finally {
        cancelRef.current = null
      }
    }
    setPhase('sending')
    try {
      await handoff({
        fromIds: sources,
        toAgentId: mode === 'agent' ? toAgent : undefined,
        toIds: mode === 'console' ? toIds : undefined,
        note: note.trim() || undefined,
        brief: text
      })
      useApp.getState().closePanel()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setPhase('ready')
    }
  }

  const canSend = sources.length > 0 && (mode === 'agent' ? !!toAgent : toIds.length > 0) && phase !== 'writing' && phase !== 'sending'
  const targetName = mode === 'agent' ? `a new ${agentLabel(toAgent)}` : toIds.length === 1 ? fleet.consoles.find((c) => c.id === toIds[0])?.name : `${toIds.length} consoles`

  return (
    <Modal
      title="Hand off"
      sub="Your CLI reads the outgoing session and writes a brief; the brief is typed into the agent that takes over."
      icon={<Send size={16} />}
      width={860}
      footer={
        <>
          {error ? <span className="ho-error small">{error}</span> : <span className="muted small">{sources.length ? `From ${sources.length === 1 ? fleet.consoles.find((c) => c.id === sources[0])?.name : `${sources.length} consoles`} → ${targetName ?? '…'}` : 'Pick a console to hand off'}</span>}
          <span className="spacer" />
          <button className="btn ghost" onClick={() => useApp.getState().closePanel()}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSend} onClick={send}>
            {phase === 'sending' ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={14} />}
            {brief.trim() ? 'Hand off' : 'Write brief & hand off'}
          </button>
        </>
      }
    >
      <div className="ho">
        <div className="ho-left">
          <div className="label">From</div>
          <div className="ho-list scrollable">
            {!fleet.consoles.length && <div className="dim small">No consoles on the board.</div>}
            {fleet.consoles.map((c) => {
              const on = sources.includes(c.id)
              const st = statusOf(statuses, live, c.id)
              return (
                <button
                  key={c.id}
                  className={`ho-pick ${on ? 'on' : ''} st-${st}`}
                  onClick={() => {
                    setSources(on ? sources.filter((x) => x !== c.id) : [...sources, c.id])
                    setToIds(toIds.filter((x) => x !== c.id))
                  }}
                >
                  <span className={`lp-check ${on ? 'on' : ''}`}>{on && <Check size={11} />}</span>
                  <AgentAvatar agentId={c.agentId} size={20} />
                  <span className="grow ho-pick-name">{c.name}</span>
                  <span className="status-dot" title={STATUS_TEXT[st]} />
                </button>
              )
            })}
          </div>

          <div className="label" style={{ marginTop: 14 }}>
            To
          </div>
          <Seg
            value={mode}
            options={[
              { value: 'agent', label: 'New agent' },
              { value: 'console', label: 'Existing console' }
            ]}
            onChange={setMode}
          />
          {mode === 'agent' ? (
            <div className="ho-agents">
              {installed.map((a) => (
                <button key={a} className={`ho-agent ${toAgent === a ? 'on' : ''}`} onClick={() => setToAgent(a)}>
                  <span className="agent-badge" style={{ background: agentColor(a), width: 20, height: 20, fontSize: 10, borderRadius: 6 }}>
                    {agentLabel(a).slice(0, 1)}
                  </span>
                  {agentLabel(a)}
                </button>
              ))}
            </div>
          ) : (
            <div className="ho-list scrollable" style={{ maxHeight: 150 }}>
              {!others.length && <div className="dim small">No other consoles.</div>}
              {others.map((c) => {
                const on = toIds.includes(c.id)
                return (
                  <button key={c.id} className={`ho-pick ${on ? 'on' : ''}`} onClick={() => setToIds(on ? toIds.filter((x) => x !== c.id) : [...toIds, c.id])}>
                    <span className={`lp-check ${on ? 'on' : ''}`}>{on && <Check size={11} />}</span>
                    <AgentAvatar agentId={c.agentId} size={20} />
                    <span className="grow ho-pick-name">{c.name}</span>
                    <span className="dim small">{agentLabel(c.agentId)}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="label" style={{ marginTop: 14 }}>
            Note <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
          </div>
          <textarea className="textarea" rows={3} placeholder="Anything the next agent should know or do first" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="ho-right">
          <div className="row">
            <div className="label grow">Brief</div>
            {phase === 'writing' ? (
              <button className="btn sm" onClick={stop}>
                <Square size={11} /> Stop
              </button>
            ) : (
              <>
                {brief && (
                  <button className="btn sm ghost" onClick={() => setEditing(!editing)}>
                    {editing ? 'Preview' : 'Edit'}
                  </button>
                )}
                <button className="btn sm" disabled={!sources.length} onClick={generate}>
                  <RefreshCw size={12} /> {brief ? 'Rewrite' : 'Write brief'}
                </button>
              </>
            )}
          </div>
          {editing ? (
            <textarea className="textarea ho-brief-edit mono" value={brief} onChange={(e) => setBrief(e.target.value)} />
          ) : (
            <div className={`ho-brief scrollable ${phase === 'writing' ? 'streaming' : ''}`}>
              {brief ? (
                <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
              ) : phase === 'writing' ? (
                <div className="ho-wait">
                  <RefreshCw size={14} className="spin" /> Reading the session…
                </div>
              ) : (
                <div className="ho-wait muted">
                  The brief covers the goal, what is done, what is left, key files and gotchas. Write it first to review, or hand off directly.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
