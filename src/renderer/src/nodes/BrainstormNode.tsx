import { useEffect, useState } from 'react'
import { Check, CircleX, FileText, LoaderCircle, RotateCcw, Sparkles, Telescope, Users, X } from 'lucide-react'
import type { NodeProps } from './types'
import { agentColor, agentLabel } from '../engine/consoles'
import { PERSONAS, dropIdea, ideaDeeper, ideaToPlan, ideaToTeam, isRunning, rerunBrainstorm, startOn, type BrainstormData, type Idea, type PersonaId } from '../voice/helm/brainstorm'

const PERSONA_TONE: Record<PersonaId, string> = { pragmatist: 'var(--ok)', wildcard: 'var(--accent)', critic: 'var(--info)' }
const DONE_LABEL = { team: 'Sent to the team', plan: 'In PLAN.md', deeper: 'Went deeper' } as const

const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

/** Oracle's brainstorm: the panel (who is thinking with which CLI) and the ranked ideas with their buttons. */
export default function BrainstormNode({ node }: NodeProps<Partial<BrainstormData>>) {
  if (!node.data?.topic) return <AskTopic nodeId={node.id} />
  const d: BrainstormData = { status: 'done', panel: [], ideas: [], startedAt: Date.now(), ...node.data, topic: node.data.topic }
  return <Session nodeId={node.id} d={d} />
}

/** A card added by hand: what should the panel think about? */
function AskTopic({ nodeId }: { nodeId: string }) {
  const [topic, setTopic] = useState('')
  const go = () => topic.trim() && startOn(nodeId, topic)
  return (
    <div className="bs bs-ask">
      <span className="bs-badge">
        <Sparkles size={14} />
      </span>
      <div className="bs-topic">What should the panel brainstorm?</div>
      <div className="muted small">A pragmatist, a wild card and a critic think about it in parallel; Oracle ranks their ideas here.</div>
      <div className="row" style={{ gap: 6, width: '100%' }}>
        <input className="input grow" placeholder="Ways to make onboarding faster" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <button className="btn primary" onClick={go}>
          Start
        </button>
      </div>
    </div>
  )
}

function Session({ nodeId, d }: { nodeId: string; d: BrainstormData }) {
  const node = { id: nodeId }
  const live = d.status === 'running' || d.status === 'merging'
  const cut = live && !isRunning(node.id)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live || cut) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [live, cut])

  const elapsed = Date.now() - d.startedAt
  const status = cut
    ? 'Cut off when Fleetboard closed'
    : d.status === 'running'
      ? `The panel is thinking · ${secs(elapsed)}`
      : d.status === 'merging'
        ? `Oracle is merging and ranking · ${secs(elapsed)}`
        : d.status === 'failed'
          ? (d.error ?? 'It did not work out')
          : `${d.ideas.length} idea${d.ideas.length === 1 ? '' : 's'}, best first`

  return (
    <div className="bs scrollable" onWheel={(e) => e.stopPropagation()}>
      <div className="bs-head">
        <span className="bs-badge">
          <Sparkles size={14} />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="bs-topic">{d.topic}</div>
          <div className={`bs-status ${d.status === 'failed' || cut ? 'bad' : ''}`}>
            {live && !cut && <LoaderCircle size={12} className="ci-spin" />}
            {status}
          </div>
        </div>
        {(!live || cut) && (
          <button className="btn sm ghost" title="Ask a fresh panel" onClick={() => rerunBrainstorm(node.id)}>
            <RotateCcw size={12} /> Run again
          </button>
        )}
      </div>

      <div className="bs-panel">
        {d.panel.map((p) => (
          <div key={p.persona} className={`bs-seat ${p.state}`} title={p.error ?? (p.standInFor ? `${agentLabel(p.standInFor)} ${p.standInWhy}, so ${agentLabel(p.agentId)} took this seat` : undefined)}>
            <span className="bs-seat-dot" style={{ background: PERSONA_TONE[p.persona] }} />
            <span className="bs-seat-name">{PERSONAS[p.persona].name}</span>
            <span className="bs-seat-agent">
              <span className="agent-dot" style={{ background: agentColor(p.agentId), width: 6, height: 6 }} />
              {agentLabel(p.agentId)}
              {p.standInFor && <span className="bs-standin"> · for {agentLabel(p.standInFor)} ({p.standInWhy})</span>}
            </span>
            <span className="spacer" />
            {p.state === 'thinking' ? (
              cut ? (
                <CircleX size={13} className="bs-bad" />
              ) : (
                <LoaderCircle size={13} className="ci-spin bs-dim" />
              )
            ) : p.state === 'done' ? (
              <span className="bs-count">
                <Check size={12} /> {p.count}
              </span>
            ) : (
              <CircleX size={13} className="bs-bad" />
            )}
          </div>
        ))}
      </div>

      {d.ideas.length === 0 && live && !cut && (
        <div className="bs-ideas">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bs-idea skeleton">
              <i style={{ width: `${50 + i * 12}%` }} />
              <i style={{ width: '90%' }} />
              <i style={{ width: '70%' }} />
            </div>
          ))}
        </div>
      )}

      {d.ideas.length > 0 && (
        <div className={`bs-ideas ${d.status === 'merging' ? 'dim' : ''}`}>
          {d.ideas.map((idea, i) => (
            <IdeaCard key={idea.id} nodeId={node.id} idea={idea} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function IdeaCard({ nodeId, idea, rank }: { nodeId: string; idea: Idea; rank: number }) {
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => unknown) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`bs-idea ${idea.done ? 'used' : ''}`}>
      <div className="bs-idea-top">
        <span className="bs-rank">{rank}</span>
        <span className="bs-title">{idea.title}</span>
        <span className="spacer" />
        {idea.from.map((f) => (
          <span key={f} className="bs-from" title={`From the ${PERSONAS[f].name.toLowerCase()}`} style={{ background: PERSONA_TONE[f] }} />
        ))}
        {idea.effort && <span className={`bs-chip effort-${idea.effort}`}>{idea.effort === 'S' ? 'small' : idea.effort === 'M' ? 'medium' : 'large'}</span>}
        {idea.impact && (
          <span className="bs-impact" title={`Impact ${idea.impact} of 5`}>
            {[1, 2, 3, 4, 5].map((k) => (
              <i key={k} className={k <= idea.impact! ? 'on' : ''} />
            ))}
          </span>
        )}
      </div>
      <div className="bs-pitch">{idea.pitch}</div>
      {idea.why && <div className="bs-why">{idea.why}</div>}
      <div className="bs-actions">
        {idea.done ? (
          <span className="bs-done">
            <Check size={12} /> {DONE_LABEL[idea.done]}
          </span>
        ) : (
          <>
            <button className="btn sm" disabled={busy} title="Start a Lead on it (or give it to the one already working)" onClick={() => act(() => ideaToTeam(nodeId, idea))}>
              <Users size={12} /> Give to team
            </button>
            <button className="btn sm" disabled={busy} title="Append to PLAN.md under Ideas" onClick={() => act(() => ideaToPlan(nodeId, idea))}>
              <FileText size={12} /> Add to PLAN.md
            </button>
            <button className="btn sm" disabled={busy} title="Brainstorm on this idea alone" onClick={() => ideaDeeper(nodeId, idea)}>
              <Telescope size={12} /> Go deeper
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="icon-btn sm" title="Drop this idea" onClick={() => dropIdea(nodeId, idea)}>
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
