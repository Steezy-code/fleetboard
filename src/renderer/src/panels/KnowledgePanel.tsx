import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, Check, Loader2, Pencil, Plus, ScanSearch, Square, Trash2 } from 'lucide-react'
import {
  type CharterDelta,
  type KnowledgeFact,
  type Provenance,
  type Topic,
  PROVENANCE_LABEL,
  TOPICS,
  TOPIC_LABEL,
  addFact,
  coerceKnowledge,
  confirmFact,
  editFact,
  forgetFact
} from '@shared/knowledge'
import { useApp } from '../state/store'
import { Modal } from '../ui/Modal'
import { changeKnowledge, learnKnowledge, refreshKnowledge } from '../fleet/knowledge'

// Repo knowledge: every fact Fleetboard holds about this repo, where it came from, and a way to argue
// with each one. A fact nobody can see the source of, or remove, would quietly shape every charter
// after it — so nothing here is hidden behind the charter that cites it.

const TINT: Record<Provenance, string> = { repo: '#3ecf8e', readme: '#60a5fa', inferred: '#f5b740', you: '#c084fc' }
const FIELD_LABEL: Record<CharterDelta['field'], string> = { understood: 'Understood', assumptions: 'Assumptions', wontTouch: 'Won’t touch', doneWhen: 'Done when', question: 'Question' }

const ago = (t: number) => {
  const ms = Date.now() - t
  return ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`
}

type Tab = 'facts' | 'edits'

export default function KnowledgePanel({ tab: initialTab }: { tab?: Tab }) {
  const project = useApp((s) => s.project)
  const raw = useApp((s) => s.project?.extras.knowledge)
  const plannerAgent = useApp((s) => s.settings.plannerAgent)
  const k = useMemo(() => coerceKnowledge(raw), [raw])
  const [tab, setTab] = useState<Tab>(initialTab ?? 'facts')
  const [adding, setAdding] = useState<{ topic: Topic; text: string } | null>(null)
  const [learning, setLearning] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const stop = useRef<(() => void) | null>(null)

  // the free read, so what is shown is what the files say now
  useEffect(() => void refreshKnowledge(), [])
  // closing the panel mid-rebuild stops the run, as closing the memory scan does
  useEffect(() => () => stop.current?.(), [])

  const agentName = !plannerAgent || plannerAgent === 'claude' ? 'Claude' : plannerAgent
  const rebuild = () => {
    const run = learnKnowledge()
    stop.current = run.cancel
    setLearning(true)
    setNote(null)
    void run.promise.then((r) => {
      stop.current = null
      setLearning(false)
      setNote(r.ok ? { ok: true, text: `${agentName} added ${r.added} fact${r.added === 1 ? '' : 's'}.` } : { ok: false, text: r.error ?? 'The rebuild failed.' })
    })
  }

  if (!project)
    return (
      <Modal title="Repo knowledge" icon={<BookMarked size={17} />}>
        <div className="empty">Open a project to see what is known about it.</div>
      </Modal>
    )

  const deltas = [...k.deltas].reverse()
  return (
    <Modal
      title="Repo knowledge"
      sub="What Fleetboard knows about this repo, and where each fact came from. Charters cite these; a fact you correct or delete stays that way."
      icon={<BookMarked size={17} />}
      width={700}
      headerRight={
        tab === 'facts' && (
          <div className="row" style={{ gap: 6 }}>
            {learning ? (
              <button className="btn sm" onClick={() => stop.current?.()}>
                <Square size={11} /> Stop
              </button>
            ) : (
              <button className="btn sm" title={`Reads the repo again, then asks ${agentName} once to read the readme and source. Read-only.`} onClick={rebuild}>
                <ScanSearch size={13} /> Rebuild
              </button>
            )}
            <button className="btn sm primary" onClick={() => setAdding({ topic: 'style', text: '' })}>
              <Plus size={13} /> Add a fact
            </button>
          </div>
        )
      }
      footer={
        tab === 'facts' ? (
          <span className="dim small">
            Checks and style are read from the repo’s own files whenever it opens. Rebuild asks {agentName} once for the rest — one planner call.
            {k.learnedAt ? ` Last rebuilt ${ago(k.learnedAt)}.` : ''}
          </span>
        ) : (
          <>
            <span className="dim small grow">Kept so that a correction you make often can later become a fact. Nothing reads them yet.</span>
            <button
              className="btn sm ghost"
              disabled={!deltas.length}
              onClick={async () => (await useApp.getState().confirm({ title: 'Forget every charter edit?', confirm: 'Forget', danger: true })) && changeKnowledge((x) => ({ ...x, deltas: [] }))}
            >
              <Trash2 size={12} /> Forget these
            </button>
          </>
        )
      }
    >
      <div className="mem-tabs">
        <button className={`mem-tab ${tab === 'facts' ? 'on' : ''}`} onClick={() => setTab('facts')}>
          Facts <span className="mem-count">{k.facts.length}</span>
        </button>
        <button className={`mem-tab ${tab === 'edits' ? 'on' : ''}`} onClick={() => setTab('edits')}>
          Your charter edits <span className="mem-count">{k.deltas.length}</span>
        </button>
      </div>

      {tab === 'edits' ? (
        deltas.length ? (
          <div className="mem-list">
            {deltas.map((d, i) => (
              <Delta key={`${d.at}-${i}`} d={d} />
            ))}
          </div>
        ) : (
          <div className="empty mem-empty small">When you change a charter before starting it, each field you changed is kept here.</div>
        )
      ) : (
        <>
          {learning && (
            <div className="kn-note">
              <Loader2 size={13} className="spin" /> {agentName} is reading the repo…
            </div>
          )}
          {note && <div className={`kn-note ${note.ok ? '' : 'bad'}`}>{note.text}</div>}
          {adding && (
            <div className="mem-card kn-add">
              <div className="grow">
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {TOPICS.map((t) => (
                    <button key={t} className={`chip ${adding.topic === t ? 'on' : ''}`} onClick={() => setAdding({ ...adding, topic: t })}>
                      {TOPIC_LABEL[t]}
                    </button>
                  ))}
                </div>
                <input
                  className="input"
                  autoFocus
                  placeholder="e.g. Never edit src/gen — it is generated"
                  value={adding.text}
                  onChange={(e) => setAdding({ ...adding, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setAdding(null)
                    if (e.key === 'Enter' && adding.text.trim()) {
                      changeKnowledge((x) => addFact(x, adding.topic, adding.text))
                      setAdding(null)
                    }
                  }}
                />
              </div>
            </div>
          )}
          {k.facts.length === 0 ? (
            <div className="empty mem-empty">
              <div className="mem-empty-icon">
                <BookMarked size={26} />
              </div>
              <div style={{ color: 'var(--text)', fontWeight: 550 }}>Nothing known about {project.name} yet</div>
              <div className="small" style={{ maxWidth: 380, lineHeight: 1.5 }}>
                Nothing in its files says how it is checked or styled. Rebuild to have {agentName} read the readme and source, or add a fact yourself. A goal works without any: its charter just has more guesses.
              </div>
            </div>
          ) : (
            TOPICS.map((t) => {
              const facts = k.facts.filter((f) => f.topic === t)
              return facts.length ? (
                <div key={t} className="kn-topic">
                  <div className="label">{TOPIC_LABEL[t]}</div>
                  <div className="mem-list">
                    {facts.map((f) => (
                      <Fact key={f.key} f={f} />
                    ))}
                  </div>
                </div>
              ) : null
            })
          )}
        </>
      )}
    </Modal>
  )
}

function Fact({ f }: { f: KnowledgeFact }) {
  const [draft, setDraft] = useState<{ text: string; command: string } | null>(null)
  const save = () => {
    if (!draft?.text.trim()) return
    changeKnowledge((k) => editFact(k, f.key, { text: draft.text, ...(f.command !== undefined || draft.command ? { command: draft.command } : {}) }))
    setDraft(null)
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') setDraft(null)
  }
  return (
    <div className="mem-card kn-fact" data-key={f.key}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span className="mem-pill" style={{ color: TINT[f.provenance], borderColor: `color-mix(in srgb, ${TINT[f.provenance]} 45%, transparent)`, background: `color-mix(in srgb, ${TINT[f.provenance]} 12%, transparent)` }}>
              {PROVENANCE_LABEL[f.provenance]}
            </span>
            {f.source && <span className="kn-source mono">{f.source}</span>}
            {f.provenance === 'inferred' && <span className="dim small">not evidence until you confirm it</span>}
          </div>
          {draft ? (
            <>
              <input className="input" autoFocus value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={keys} />
              {(f.command !== undefined || f.topic === 'checks') && (
                <input className="input mono kn-cmd-input" placeholder="the command that runs it" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} onKeyDown={keys} />
              )}
            </>
          ) : (
            <>
              <div className="mem-body">{f.text}</div>
              {f.command && !f.text.includes(f.command) && <div className="kn-cmd mono">{f.command}</div>}
            </>
          )}
        </div>
        {draft ? (
          <button className="icon-btn sm" title="Save — a rebuild will leave it as you wrote it" disabled={!draft.text.trim()} onClick={save}>
            <Check size={12} />
          </button>
        ) : (
          <>
            {f.provenance === 'inferred' && (
              <button className="icon-btn sm" title="This is right — a charter may then cite it" onClick={() => changeKnowledge((k) => confirmFact(k, f.key))}>
                <Check size={12} />
              </button>
            )}
            <button className="icon-btn sm" title="Correct it" onClick={() => setDraft({ text: f.text, command: f.command ?? '' })}>
              <Pencil size={12} />
            </button>
          </>
        )}
        <button className="icon-btn sm" title="Delete — a rebuild will not bring it back" onClick={() => changeKnowledge((k) => forgetFact(k, f.key))}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

function Delta({ d }: { d: CharterDelta }) {
  return (
    <div className="mem-card kn-delta">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <span className="mem-pill" style={{ color: 'var(--accent)', borderColor: 'var(--accent-line)' }}>
            {FIELD_LABEL[d.field]}
          </span>
          <span className="dim small grow kn-request" title={d.request}>
            {d.request}
          </span>
          <span className="dim small">{ago(d.at)}</span>
        </div>
        {'before' in d ? (
          <div className="kn-change">
            <span className="kn-was">{d.before || '(empty)'}</span>
            <span className="dim">→</span>
            <span className="kn-now">{d.after || (d.field === 'question' ? '(settled)' : '(empty)')}</span>
          </div>
        ) : (
          <div className="kn-change">
            {d.added.map((x, i) => (
              <span key={`a${i}`} className="kn-now">
                + {x}
              </span>
            ))}
            {d.removed.map((x, i) => (
              <span key={`r${i}`} className="kn-was">
                − {x}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
