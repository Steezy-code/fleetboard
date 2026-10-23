import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Clock, Minus, MoonStar, Pencil, Play, Plus, Repeat, ScanSearch, Trash2 } from 'lucide-react'
import { useApp } from '../state/store'
import { useNow } from '../lib/useNow'
import { agentColor, agentLabel } from '../engine/consoles'
import {
  describeLoop,
  fmtEvery,
  newLoop,
  nextRunAt,
  rateEstimate,
  removeLoop,
  runLoopNow,
  saveEditedLoop,
  setLoopEnabled,
  upsertLoop,
  DEFAULT_STOP,
  type Loop,
  type LoopTrigger
} from '../engine/loops'
import { Modal, Seg, Switch } from '../ui/Modal'
import { plural, useFleet, useInstalledAgents } from '../orchestration/fleet'

const SUB =
  'Recurring instructions for your agents — on a schedule, when they go idle, or when their output says so. Loops can stop themselves when a goal is met.'

interface Template {
  name: string
  instruction: string
  trigger: LoopTrigger
  stop?: Partial<Loop['stop']>
}

const TEMPLATES: Template[] = [
  {
    name: 'Progress check',
    instruction: 'Give me a two-line status: what you finished since the last check and what you are doing next.',
    trigger: { kind: 'schedule', everyMin: 15 }
  },
  {
    name: 'Keep them moving',
    instruction: 'If you are blocked, say exactly what you need from me. Otherwise continue with the next step of the task.',
    trigger: { kind: 'idle' },
    stop: { afterRuns: true, runs: 20 }
  },
  {
    name: 'Build rescue',
    instruction: 'The last build or command failed. Read the error, fix the root cause, and run it again.',
    trigger: { kind: 'output', pattern: 'error|failed|ERR!', regex: true },
    stop: { goal: true, goalKind: 'command', command: 'npm run build' }
  },
  {
    name: 'Test watchdog',
    instruction: 'Run the test suite. If anything fails, fix it and run the tests again.',
    trigger: { kind: 'schedule', everyMin: 30 },
    stop: { goal: true, goalKind: 'judge', judgeAgent: 'claude', goalText: 'ALL GREEN — every test passes' }
  },
  {
    name: 'Commit checkpoint',
    instruction: 'If you have working changes, commit them with a clear message. Do not push.',
    trigger: { kind: 'schedule', everyMin: 60 }
  },
  {
    name: 'Review sweep',
    instruction: 'Review the changes made since the last sweep for bugs, missing tests and leftovers. Fix what you find.',
    trigger: { kind: 'schedule', everyMin: 120 },
    stop: { afterRuns: true, runs: 4 }
  },
  {
    name: 'Hourly summary',
    instruction: 'Summarize in three bullets what you did in the last hour and what comes next.',
    trigger: { kind: 'schedule', everyMin: 60 }
  }
]

const EVERY = [5, 10, 15, 30, 60, 120]

const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

const TriggerIcon = ({ t }: { t: LoopTrigger }) =>
  t.kind === 'schedule' ? <Clock size={15} /> : t.kind === 'idle' ? <MoonStar size={15} /> : <ScanSearch size={15} />

function Stepper({ value, onChange, min = 1, max = 999, step = 1, suffix }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="lp-stepper">
      <button className="icon-btn sm" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min}>
        <Minus size={12} />
      </button>
      <input
        className="lp-num mono"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
      />
      <button className="icon-btn sm" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max}>
        <Plus size={12} />
      </button>
      {suffix && <span className="muted small">{suffix}</span>}
    </div>
  )
}

// ---------------- list ----------------

/** every way a loop ends, in the row's words (a stalled loop used to say "Time limit reached") */
const ENDED: Record<NonNullable<Loop['ended']>['reason'], string> = {
  goal: 'Goal met ✓',
  runs: 'Finished runs',
  time: 'Time limit reached',
  stalled: 'Stopped: nothing was changing',
  unchecked: 'Stopped: goal could not be checked'
}

function LoopRow({ l, now, onEdit }: { l: Loop; now: number; onEdit: () => void }) {
  const due = nextRunAt(l)
  const status = l.ended
    ? ENDED[l.ended.reason]
    : !l.enabled
      ? 'Paused'
      : due !== null
        ? `next in ${countdown(due - now)}`
        : l.trigger.kind === 'idle'
          ? 'waiting for idle'
          : 'watching output'
  return (
    <div className={`lp-row ${l.enabled ? 'on' : ''} ${l.ended?.reason === 'goal' ? 'met' : ''}`}>
      <span className="lp-row-icon">
        <TriggerIcon t={l.trigger} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="lp-row-name">{l.name}</div>
        <div className="lp-row-sum">{describeLoop(l)}</div>
        {l.lastCheck && !l.ended && <div className="lp-row-check dim small">Last check: {l.lastCheck.note}</div>}
      </div>
      <div className="lp-row-meta">
        <span className={`lp-when ${l.ended?.reason === 'goal' ? 'ok' : ''}`}>{status}</span>
        <span className="dim small">{plural(l.runs, 'run')}</span>
      </div>
      <button className="icon-btn sm" title="Run now" onClick={() => runLoopNow(l.id)} disabled={!l.enabled}>
        <Play size={13} />
      </button>
      <Switch on={l.enabled} onChange={(v) => setLoopEnabled(l.id, v)} title={l.enabled ? 'Pause loop' : 'Start loop'} />
      <button className="icon-btn sm" title="Edit" onClick={onEdit}>
        <Pencil size={13} />
      </button>
      <button
        className="icon-btn sm"
        title="Delete"
        onClick={async () => {
          if (await useApp.getState().confirm({ title: `Delete loop “${l.name}”?`, confirm: 'Delete', danger: true })) removeLoop(l.id)
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

export default function LoopsPanel({ edit }: { edit?: string }) {
  const loops = useApp((s) => (s.project?.extras.loops as Loop[] | undefined) ?? EMPTY)
  const [draft, setDraft] = useState<Loop | null>(() => (edit ? loops.find((l) => l.id === edit) ?? null : null))
  const [isNew, setIsNew] = useState(false)
  const now = useNow(1000)

  if (draft) return <LoopEditor draft={draft} setDraft={setDraft} isNew={isNew} onDone={() => setDraft(null)} />

  return (
    <Modal
      title="Loops"
      sub={SUB}
      icon={<Repeat size={17} />}
      width={780}
      headerRight={
        <button className="btn primary sm" onClick={() => (setIsNew(true), setDraft(newLoop()))}>
          <Plus size={13} /> New loop
        </button>
      }
    >
      {loops.length ? (
        <div className="lp-list">
          {loops.map((l) => (
            <LoopRow key={l.id} l={l} now={now} onEdit={() => (setIsNew(false), setDraft({ ...l }))} />
          ))}
        </div>
      ) : (
        <div className="lp-empty">
          <div className="lp-empty-ring">
            <Repeat size={22} />
          </div>
          <div className="lp-empty-title">No loops yet</div>
          <div className="muted">Start from a template:</div>
          <div className="lp-chips">
            {TEMPLATES.map((t) => (
              <button key={t.name} className="chip" onClick={() => (setIsNew(true), setDraft(fromTemplate(newLoop(), t)))}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

const EMPTY: Loop[] = []

function fromTemplate(l: Loop, t: Template): Loop {
  return { ...l, name: t.name, instruction: t.instruction, trigger: { ...t.trigger }, stop: { ...DEFAULT_STOP, ...t.stop } }
}

// ---------------- editor ----------------

function WhenCard({ on, icon, title, sub, onClick, children }: { on: boolean; icon: React.ReactNode; title: string; sub: string; onClick: () => void; children?: React.ReactNode }) {
  return (
    <div className={`lp-when-card ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <span className="lp-when-icon">{icon}</span>
        <div className="grow">
          <div className="lp-when-title">{title}</div>
          <div className="muted small">{sub}</div>
        </div>
        <span className={`lp-radio ${on ? 'on' : ''}`} />
      </div>
      {on && children && (
        <div className="lp-when-body" onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  )
}

function LoopEditor({ draft, setDraft, isNew, onDone }: { draft: Loop; setDraft: (l: Loop) => void; isNew: boolean; onDone: () => void }) {
  const fleet = useFleet()
  const installed = useInstalledAgents()
  const judges = useMemo(() => installed.filter((a) => a !== 'shell'), [installed])
  const set = (patch: Partial<Loop>) => setDraft({ ...draft, ...patch })
  const setStop = (patch: Partial<Loop['stop']>) => setDraft({ ...draft, stop: { ...draft.stop, ...patch } })
  const t = draft.trigger
  const s = draft.stop
  const pickIds = draft.target.kind === 'pick' ? draft.target.ids : []
  const outputBad = t.kind === 'output' && t.regex && (() => {
    try {
      new RegExp(t.pattern)
      return false
    } catch {
      return true
    }
  })()
  const valid =
    draft.name.trim() &&
    draft.instruction.trim() &&
    !(t.kind === 'output' && (!t.pattern.trim() || outputBad)) &&
    !(draft.target.kind === 'pick' && !pickIds.length) &&
    !(s.goal && s.goalKind === 'command' && !s.command.trim())

  const save = () => {
    if (!valid) return
    const now = Date.now()
    if (isNew) upsertLoop({ ...draft, enabled: true, startedAt: now, createdAt: now })
    else if (!saveEditedLoop(draft)) {
      useApp.getState().toast(`Loop “${draft.name}” was deleted while you edited it, so it was not saved`, 'warn')
      onDone()
      return
    }
    useApp.getState().toast(isNew ? `Loop “${draft.name}” started` : 'Loop saved', 'ok')
    onDone()
  }

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          <button className="icon-btn sm" onClick={onDone} title="Back to loops">
            <ArrowLeft size={14} />
          </button>
          {isNew ? 'New loop' : 'Edit loop'}
        </span>
      }
      sub={SUB}
      icon={<Repeat size={17} />}
      width={780}
      footer={
        <>
          <div className="grow lp-summary">
            <div>{describeLoop(draft)}</div>
            <div className="dim small">{rateEstimate(draft)}</div>
          </div>
          <button className="btn ghost" onClick={onDone}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            {isNew ? 'Create loop' : 'Save loop'}
          </button>
        </>
      }
    >
      <div className="lp-editor">
        <div className="lp-section">
          <div className="label">Templates</div>
          <div className="lp-chips">
            {TEMPLATES.map((tp) => (
              <button key={tp.name} className={`chip ${draft.name === tp.name ? 'on' : ''}`} onClick={() => setDraft(fromTemplate(draft, tp))}>
                {tp.name}
              </button>
            ))}
          </div>
        </div>

        <div className="lp-section">
          <div className="label">Name</div>
          <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Progress check" />
        </div>

        <div className="lp-section">
          <div className="label">Instruction</div>
          <textarea
            className="textarea"
            rows={3}
            value={draft.instruction}
            onChange={(e) => set({ instruction: e.target.value })}
            placeholder="What should the agents be told each time?"
          />
          <div className="dim small">Typed into each targeted console exactly as written.</div>
        </div>

        <div className="lp-section">
          <div className="label">When</div>
          <div className="lp-when-grid">
            <WhenCard
              on={t.kind === 'schedule'}
              icon={<Clock size={16} />}
              title="On a schedule"
              sub="Every few minutes, while the loop runs."
              onClick={() => t.kind !== 'schedule' && set({ trigger: { kind: 'schedule', everyMin: 15 } })}
            >
              {t.kind === 'schedule' && (
                <>
                  <div className="lp-chips">
                    {EVERY.map((m) => (
                      <button key={m} className={`chip sm ${t.everyMin === m ? 'on' : ''}`} onClick={() => set({ trigger: { kind: 'schedule', everyMin: m } })}>
                        {fmtEvery(m)}
                      </button>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="muted small">every</span>
                    <Stepper value={t.everyMin} min={1} max={1440} onChange={(n) => set({ trigger: { kind: 'schedule', everyMin: n } })} suffix="min" />
                  </div>
                </>
              )}
            </WhenCard>
            <WhenCard
              on={t.kind === 'idle'}
              icon={<MoonStar size={16} />}
              title="When an agent goes idle"
              sub="Fires the moment a targeted console finishes."
              onClick={() => set({ trigger: { kind: 'idle' } })}
            />
            <WhenCard
              on={t.kind === 'output'}
              icon={<ScanSearch size={16} />}
              title="When output contains…"
              sub="Watches what the console prints."
              onClick={() => t.kind !== 'output' && set({ trigger: { kind: 'output', pattern: '', regex: false } })}
            >
              {t.kind === 'output' && (
                <>
                  <input
                    className={`input mono ${outputBad ? 'bad' : ''}`}
                    autoFocus
                    placeholder={t.regex ? 'error|failed' : 'Tests failed'}
                    value={t.pattern}
                    onChange={(e) => set({ trigger: { ...t, pattern: e.target.value } })}
                  />
                  <label className="row small" style={{ marginTop: 8 }}>
                    <Switch on={t.regex} onChange={(v) => set({ trigger: { ...t, regex: v } })} />
                    <span className="muted">Regular expression</span>
                    {outputBad && <span style={{ color: 'var(--danger)' }}>invalid</span>}
                  </label>
                </>
              )}
            </WhenCard>
          </div>
        </div>

        <div className="lp-section">
          <div className="label">Target</div>
          <Seg
            value={draft.target.kind}
            options={[
              { value: 'all', label: `All consoles · ${fleet.consoles.length}` },
              { value: 'pick', label: 'Pick consoles' }
            ]}
            onChange={(v) => set({ target: v === 'all' ? { kind: 'all' } : { kind: 'pick', ids: pickIds } })}
          />
          {draft.target.kind === 'all' ? (
            <div className="dim small">Every console on the board, plus any opened later.</div>
          ) : (
            <div className="lp-picks scrollable">
              {!fleet.consoles.length && <div className="dim small">No consoles yet.</div>}
              {fleet.consoles.map((c) => {
                const on = pickIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    className={`lp-pick ${on ? 'on' : ''}`}
                    onClick={() => set({ target: { kind: 'pick', ids: on ? pickIds.filter((x) => x !== c.id) : [...pickIds, c.id] } })}
                  >
                    <span className={`lp-check ${on ? 'on' : ''}`}>{on && <Check size={11} />}</span>
                    <span className="agent-dot" style={{ background: agentColor(c.agentId) }} />
                    <span className="grow">{c.name}</span>
                    <span className="dim small">
                      {agentLabel(c.agentId)}
                      {fleet.multiWs ? ` · ${c.workspaceName}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="lp-section">
          <div className="label">Stop</div>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="grow">After a number of runs</div>
              {s.afterRuns && <Stepper value={s.runs} min={1} max={999} onChange={(n) => setStop({ runs: n })} suffix="runs" />}
              <Switch on={s.afterRuns} onChange={(v) => setStop({ afterRuns: v })} />
            </div>
            <div className="settings-row">
              <div className="grow">After a time limit</div>
              {s.afterTime && <Stepper value={s.minutes} min={1} max={1440} step={5} onChange={(n) => setStop({ minutes: n })} suffix="min" />}
              <Switch on={s.afterTime} onChange={(v) => setStop({ afterTime: v })} />
            </div>
            <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="row">
                <div className="grow">
                  <div>When a goal is met</div>
                  <div className="muted small">Checked before each run; the loop retires itself once it is met.</div>
                </div>
                <Switch on={s.goal} onChange={(v) => setStop({ goal: v })} />
              </div>
              {s.goal && (
                <div className="lp-goal">
                  <Seg
                    value={s.goalKind}
                    options={[
                      { value: 'command', label: 'A command passes' },
                      { value: 'judge', label: 'An agent judges' }
                    ]}
                    onChange={(v) => setStop({ goalKind: v })}
                  />
                  {s.goalKind === 'command' ? (
                    <>
                      <input className="input mono" placeholder="npm test" value={s.command} onChange={(e) => setStop({ command: e.target.value })} />
                      <div className="dim small">Fleetboard runs it in the project folder, in your shell, before each run. Exit code 0 means the goal is met.</div>
                    </>
                  ) : (
                    <>
                      <div className="row">
                        <select className="select" style={{ width: 180 }} value={s.judgeAgent} onChange={(e) => setStop({ judgeAgent: e.target.value })}>
                          {(judges.length ? judges : ['claude']).map((a) => (
                            <option key={a} value={a}>
                              {agentLabel(a)}
                            </option>
                          ))}
                        </select>
                        <input className="input" placeholder="ALL GREEN" value={s.goalText} onChange={(e) => setStop({ goalText: e.target.value })} />
                      </div>
                      <div className="dim small">The agent reads the targeted consoles’ recent output and decides whether the goal is met.</div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lp-section">
          <div className="label">Behavior</div>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="grow">
                <div>Keep running behind other tabs</div>
                <div className="muted small">Off: only consoles in the workspace you are looking at receive the instruction.</div>
              </div>
              <Switch on={draft.background} onChange={(v) => set({ background: v })} />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
