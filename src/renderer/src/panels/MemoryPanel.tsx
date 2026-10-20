import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Brain, Check, Circle, FileText, Loader2, Pencil, Plus, ScanSearch, Send, Square, Trash2 } from 'lucide-react'
import type { MemoryCard } from '@shared/types'
import { extractJson, runCli } from '../lib/api'
import { useApp } from '../state/store'
import { agentColor } from '../engine/consoles'
import { Modal, Seg, Switch } from '../ui/Modal'
import {
  CATEGORIES,
  CATEGORY_TINT,
  cardsToMarkdown,
  loadGlobalCards,
  newCard,
  normalizeCategory,
  pushTargets,
  pushToConsoles,
  saveGlobalCards,
  scanPrompt,
  setRepoCards,
  type PushTarget
} from '../continuity/memory'

type Tab = 'repo' | 'global'
type View = { kind: 'list' } | { kind: 'edit'; card: MemoryCard; isNew: boolean } | { kind: 'scan' } | { kind: 'push'; cards: MemoryCard[] }

interface Proposal {
  category: MemoryCard['category']
  title: string
  body: string
  on: boolean
}

/** Memory: what your agents should know, kept per repo and globally, pushed to consoles only on demand. */
export default function MemoryPanel({ tab: initialTab }: { tab?: Tab }) {
  const project = useApp((s) => s.project)
  const repo = useApp((s) => (s.project?.extras.memory as MemoryCard[] | undefined) ?? EMPTY)
  const [global, setGlobal] = useState<MemoryCard[]>([])
  const [tab, setTab] = useState<Tab>(initialTab ?? 'repo')
  const [view, setView] = useState<View>({ kind: 'list' })

  useEffect(() => {
    loadGlobalCards().then(setGlobal)
  }, [])

  const cards = tab === 'repo' ? repo : global
  const saveScope = async (scope: Tab, next: MemoryCard[]) => {
    if (scope === 'repo') setRepoCards(next)
    else {
      setGlobal(next)
      await saveGlobalCards(next)
    }
  }

  const upsert = async (card: MemoryCard, prevScope?: MemoryCard['scope']) => {
    const scope: Tab = card.scope === 'global' ? 'global' : 'repo'
    // moved between scopes: drop from the old list
    if (prevScope && prevScope !== card.scope) {
      const old: Tab = prevScope === 'global' ? 'global' : 'repo'
      await saveScope(old, (old === 'repo' ? repo : global).filter((c) => c.id !== card.id))
    }
    const list = scope === 'repo' ? repo : global
    const exists = list.some((c) => c.id === card.id)
    await saveScope(scope, exists ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card])
    setTab(scope)
  }

  const remove = async (card: MemoryCard) => {
    const ok = await useApp.getState().confirm({ title: `Delete "${card.title || 'memory'}"?`, confirm: 'Delete', danger: true })
    if (!ok) return
    const scope: Tab = card.scope === 'global' ? 'global' : 'repo'
    await saveScope(scope, (scope === 'repo' ? repo : global).filter((c) => c.id !== card.id))
    setView({ kind: 'list' })
  }

  const placeOnBoard = () => {
    const all = [...repo, ...global]
    if (!all.length) return
    const app = useApp.getState()
    const id = app.addNode({ type: 'doc', title: 'Project memory', w: 520, h: 640, data: { markdown: cardsToMarkdown(all), title: 'Project memory' } })
    app.closePanel()
    setTimeout(() => useApp.getState().focusItem(id), 60)
  }

  if (!project)
    return (
      <Modal title="Memory" icon={<Brain size={17} />}>
        <div className="empty">Open a project to use memory.</div>
      </Modal>
    )

  if (view.kind === 'edit')
    return <Editor card={view.card} isNew={view.isNew} onCancel={() => setView({ kind: 'list' })} onDelete={remove} onSave={async (c, prev) => (await upsert(c, prev), setView({ kind: 'list' }))} />

  if (view.kind === 'push') return <PushView cards={view.cards} onBack={() => setView({ kind: 'list' })} />

  return (
    <Modal
      title="Memory"
      sub="What your agents should know — pushed from a memory card when you say so."
      icon={<Brain size={17} />}
      width={680}
      headerRight={
        view.kind === 'list' && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setView({ kind: 'scan' })}>
              <ScanSearch size={13} /> Scan repo
            </button>
            <button className="btn sm primary" onClick={() => setView({ kind: 'edit', isNew: true, card: newCard({ scope: tab === 'repo' ? 'repo' : 'global' }) })}>
              <Plus size={13} /> New memory
            </button>
          </div>
        )
      }
      footer={
        view.kind === 'list' && (
          <>
            <button className="btn ghost" disabled={!repo.length && !global.length} onClick={placeOnBoard}>
              <FileText size={14} /> Place card on board
            </button>
            <span className="spacer" />
            <span className="dim small">Nothing reaches a console unless you push it.</span>
            <button className="btn" disabled={!cards.length} onClick={() => setView({ kind: 'push', cards })}>
              <Send size={13} /> Push {cards.length > 1 ? `all ${cards.length}` : ''} to consoles
            </button>
          </>
        )
      }
    >
      <div className="mem-tabs">
        <button className={`mem-tab ${tab === 'repo' ? 'on' : ''}`} onClick={() => setTab('repo')}>
          {project.name} <span className="mem-count">{repo.length}</span>
        </button>
        <button className={`mem-tab ${tab === 'global' ? 'on' : ''}`} onClick={() => setTab('global')}>
          All repos <span className="mem-count">{global.length}</span>
        </button>
      </div>

      {view.kind === 'scan' ? (
        <ScanView
          existing={repo}
          onCancel={() => setView({ kind: 'list' })}
          onAdd={async (props) => {
            const now = Date.now()
            const added = props.map((p, i) => newCard({ scope: 'repo', category: p.category, title: p.title, body: p.body, createdAt: now + i, updatedAt: now + i }))
            setRepoCards([...repo, ...added])
            setTab('repo')
            setView({ kind: 'list' })
            useApp.getState().toast(`Added ${added.length} memor${added.length === 1 ? 'y' : 'ies'}`, 'ok')
          }}
        />
      ) : cards.length === 0 ? (
        <div className="empty mem-empty">
          <div className="mem-empty-icon">
            <Brain size={26} />
          </div>
          <div style={{ color: 'var(--text)', fontWeight: 550 }}>{tab === 'repo' ? `Nothing remembered for ${project.name} yet` : 'No memories for all repos yet'}</div>
          <div className="small" style={{ maxWidth: 360, lineHeight: 1.5 }}>
            {tab === 'repo'
              ? 'Scan the repo and review what an agent proposes, or write a memory yourself.'
              : 'Global memories apply to every project — preferences, tools, habits.'}
          </div>
          <div className="row">
            {tab === 'repo' && (
              <button className="btn sm" onClick={() => setView({ kind: 'scan' })}>
                <ScanSearch size={13} /> Scan repo
              </button>
            )}
            <button className="btn sm" onClick={() => setView({ kind: 'edit', isNew: true, card: newCard({ scope: tab === 'repo' ? 'repo' : 'global' }) })}>
              <Plus size={13} /> New memory
            </button>
          </div>
        </div>
      ) : (
        <div className="mem-list">
          {CATEGORIES.flatMap((cat) => cards.filter((c) => c.category === cat)).map((c) => (
            <div key={c.id} className="mem-card">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                    <CategoryPill cat={c.category} />
                    <span className="mem-title">{c.title}</span>
                  </div>
                  <div className="mem-body">{c.body}</div>
                </div>
                <button className="icon-btn sm" title="Push to consoles" onClick={() => setView({ kind: 'push', cards: [c] })}>
                  <Send size={12} />
                </button>
                <button className="icon-btn sm" title="Edit" onClick={() => setView({ kind: 'edit', isNew: false, card: c })}>
                  <Pencil size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

const EMPTY: MemoryCard[] = []

function CategoryPill({ cat }: { cat: MemoryCard['category'] }) {
  return (
    <span className="mem-pill" style={{ color: CATEGORY_TINT[cat], borderColor: `color-mix(in srgb, ${CATEGORY_TINT[cat]} 45%, transparent)`, background: `color-mix(in srgb, ${CATEGORY_TINT[cat]} 12%, transparent)` }}>
      {cat}
    </span>
  )
}

function Editor({
  card,
  isNew,
  onCancel,
  onSave,
  onDelete
}: {
  card: MemoryCard
  isNew: boolean
  onCancel: () => void
  onSave: (c: MemoryCard, prevScope?: MemoryCard['scope']) => void
  onDelete: (c: MemoryCard) => void
}) {
  const [draft, setDraft] = useState(card)
  const project = useApp((s) => s.project)
  const valid = draft.title.trim() && draft.body.trim()
  const save = () =>
    valid &&
    onSave(
      { ...draft, title: draft.title.trim(), body: draft.body.trim(), updatedAt: Date.now(), repoPath: draft.scope === 'repo' ? project?.path : undefined },
      isNew ? undefined : card.scope
    )
  return (
    <Modal
      title={isNew ? 'New memory' : 'Edit memory'}
      sub="Short, durable facts work best — one idea per card."
      icon={<Brain size={17} />}
      width={600}
      onClose={onCancel}
      footer={
        <>
          {!isNew && (
            <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={() => onDelete(card)}>
              <Trash2 size={13} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            Save memory
          </button>
        </>
      }
    >
      <div className="label" style={{ margin: '4px 0 8px' }}>
        Category
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`chip ${draft.category === c ? 'on' : ''}`}
            style={draft.category === c ? { background: CATEGORY_TINT[c], borderColor: CATEGORY_TINT[c], color: '#111' } : undefined}
            onClick={() => setDraft({ ...draft, category: c })}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="label" style={{ margin: '16px 0 6px' }}>
        Title
      </div>
      <input className="input" autoFocus placeholder="e.g. Run tests with pnpm test:unit" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <div className="label" style={{ margin: '14px 0 6px' }}>
        Memory
      </div>
      <textarea
        className="textarea"
        rows={6}
        placeholder="What should an agent know? Paths, commands, why it matters."
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && save()}
      />
      <div className="row" style={{ marginTop: 14 }}>
        <span className="muted grow">Applies to</span>
        <Seg<MemoryCard['scope']>
          value={draft.scope}
          onChange={(scope) => setDraft({ ...draft, scope })}
          options={[
            { value: 'repo', label: 'This repo' },
            { value: 'global', label: 'All repos' }
          ]}
        />
      </div>
    </Modal>
  )
}

const STEPS = ['Launch', 'Read the repo', 'Write facts'] as const

function ScanView({ existing, onCancel, onAdd }: { existing: MemoryCard[]; onCancel: () => void; onAdd: (p: Proposal[]) => void }) {
  const project = useApp((s) => s.project)!
  const plannerAgent = useApp((s) => s.settings.plannerAgent)
  const [step, setStep] = useState(0)
  const [activity, setActivity] = useState<string[]>([])
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chars, setChars] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let done = false
    const run = runCli(
      { prompt: scanPrompt(project.path, existing), cwd: project.path },
      (_c, all) => {
        setStep(2)
        setChars(all.length)
      },
      (line) => {
        setStep((s) => Math.max(s, 1))
        setActivity((a) => [...a.slice(-5), line])
      }
    )
    cancelRef.current = run.cancel
    run.promise
      .then(({ code, text }) => {
        done = true
        // the model wrote this, so every field is unknown until it has been through String()/normalize
        type ProposedFact = { category?: unknown; title?: unknown; body?: unknown }
        const raw = extractJson<unknown>(text)
        const facts = (raw as { facts?: unknown } | null)?.facts
        const arr: ProposedFact[] | null = Array.isArray(raw) ? (raw as ProposedFact[]) : Array.isArray(facts) ? (facts as ProposedFact[]) : null
        if (!arr?.length) {
          setError(code ? text.slice(-400) || `Exited with ${code}` : 'The agent did not return any facts.')
          return
        }
        setProposals(
          arr
            .filter((x) => x && (x.title || x.body))
            .slice(0, 16)
            .map((x) => ({ category: normalizeCategory(x.category), title: String(x.title ?? '').trim(), body: String(x.body ?? '').trim(), on: true }))
        )
      })
      .catch((e) => setError(String(e?.message ?? e)))
    return () => {
      // closing the panel mid-scan stops the run
      if (!done) run.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const agentName = plannerAgent === 'claude' ? 'Claude' : plannerAgent
  if (proposals) {
    const n = proposals.filter((p) => p.on).length
    return (
      <div className="mem-review">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="label grow">Review proposals</span>
          <button className="btn ghost sm" onClick={() => setProposals(proposals.map((p) => ({ ...p, on: n !== proposals.length })))}>
            {n === proposals.length ? 'Uncheck all' : 'Check all'}
          </button>
        </div>
        <div className="mem-list">
          {proposals.map((p, i) => (
            <label key={i} className={`mem-card proposal ${p.on ? '' : 'off'}`}>
              <input type="checkbox" checked={p.on} onChange={() => setProposals(proposals.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
              <div className="grow">
                <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <CategoryPill cat={p.category} />
                  <span className="mem-title">{p.title}</span>
                </div>
                <div className="mem-body">{p.body}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>
            Discard
          </button>
          <button className="btn primary" disabled={!n} onClick={() => onAdd(proposals.filter((p) => p.on))}>
            Add {n} to memory
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mem-scan">
      <div className="mem-scan-head">
        {error ? <Circle size={14} color="var(--danger)" /> : <Loader2 size={14} className="spin" color="var(--accent)" />}
        <span className="grow" style={{ fontWeight: 600 }}>
          {error ? 'Scan failed' : `Scanning with ${agentName}`}
        </span>
        <button
          className="btn sm"
          onClick={() => {
            cancelRef.current?.()
            onCancel()
          }}
        >
          <Square size={11} /> {error ? 'Back' : 'Stop'}
        </button>
      </div>
      <div className="mem-steps">
        {STEPS.map((s, i) => (
          <span key={s} className={`mem-step ${i < step ? 'done' : i === step && !error ? 'now' : ''}`}>
            {i < step ? <Check size={11} /> : <span className="mem-step-n">{i + 1}</span>}
            {s}
            {i < STEPS.length - 1 && <span className="mem-step-arrow">→</span>}
          </span>
        ))}
      </div>
      <div className="mem-activity mono">
        {error ? (
          <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : activity.length ? (
          activity.map((a, i) => (
            <div key={i} className={i === activity.length - 1 ? '' : 'dim'}>
              › {a}
            </div>
          ))
        ) : (
          <div className="dim">› starting {agentName} in {project.path}</div>
        )}
        {step === 2 && !error && <div className="dim">› writing facts… {chars} chars</div>}
      </div>
      <div className="dim small" style={{ marginTop: 8 }}>
        Read-only: the agent can read files and git history, but cannot change anything.
      </div>
    </div>
  )
}

function PushView({ cards, onBack }: { cards: MemoryCard[]; onBack: () => void }) {
  // one JSON string, so the selector's result still compares by value without a shallow compare of
  // objects it rebuilds on every store change — and without a delimiter a console name can break
  const rows = useApp((s) => (s.project ? JSON.stringify(pushTargets(s.project, s.live)) : '[]'))
  const list = useMemo(() => JSON.parse(rows) as PushTarget[], [rows])
  const liveIds = list.filter((c) => c.live).map((c) => c.id)
  const [picked, setPicked] = useState<string[]>(liveIds)
  const [submit, setSubmit] = useState(false)
  const all = liveIds.length > 0 && liveIds.every((id) => picked.includes(id))

  const push = () => {
    pushToConsoles(cards, picked, submit)
    useApp.getState().toast(`Memory ${submit ? 'sent' : 'typed'} into ${picked.length} console${picked.length === 1 ? '' : 's'}${submit ? '' : ' — press Enter there to send'}`, 'ok')
    onBack()
  }

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 6 }}>
          <button className="icon-btn sm" onClick={onBack}>
            <ArrowLeft size={14} />
          </button>
          Push to consoles
        </span>
      }
      sub={`${cards.length} memor${cards.length === 1 ? 'y' : 'ies'} as one "Project memory:" message.`}
      icon={<Send size={16} />}
      width={560}
      onClose={onBack}
      footer={
        <>
          <span className="muted">Press Enter after typing</span>
          <Switch on={submit} onChange={setSubmit} />
          <span className="spacer" />
          <button className="btn" onClick={onBack}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.length} onClick={push}>
            Push to {picked.length} console{picked.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      {list.length === 0 ? (
        <div className="empty">No consoles on the board yet.</div>
      ) : (
        <div className="settings-rows">
          <label className="settings-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={all} disabled={!liveIds.length} onChange={() => setPicked(all ? [] : liveIds)} />
            <span className="grow" style={{ fontWeight: 550 }}>
              All running consoles
            </span>
            <span className="dim small">{liveIds.length}</span>
          </label>
          {list.map((c) => (
            <label key={c.id} className="settings-row" style={{ cursor: c.live ? 'pointer' : 'default', opacity: c.live ? 1 : 0.5 }}>
              <input
                type="checkbox"
                disabled={!c.live}
                checked={picked.includes(c.id)}
                onChange={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
              />
              <span className="dot" style={{ background: agentColor(c.agentId) }} />
              <span className="grow">{c.name}</span>
              <span className="dim small">{c.live ? c.ws : 'not running'}</span>
            </label>
          ))}
        </div>
      )}
      <div className="mem-preview mono">
        Project memory: {cards.map((c, i) => `${i + 1}) [${c.category}] ${c.title}`).join(' ')}
      </div>
    </Modal>
  )
}
