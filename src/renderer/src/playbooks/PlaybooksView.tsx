import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  BookCheck,
  DatabaseZap,
  GitPullRequest,
  ListTodo,
  PackageCheck,
  Paintbrush,
  Play,
  Rocket,
  ShieldCheck,
  Siren,
  Sunrise,
  TestTubes,
  Users
} from 'lucide-react'
import { CATEGORY_LABEL, PLAYBOOKS, playbookById, type Playbook, type PlaybookCategory } from './catalog'
import { lastInputs, runPlaybook } from './run'
import { errorText } from '../lib/api'
import { useApp } from '../state/store'
import { Switch } from '../ui/Modal'

const ICONS: Record<string, any> = { Rocket, Siren, ListTodo, Sunrise, ShieldCheck, TestTubes, BookCheck, DatabaseZap, GitPullRequest, PackageCheck, Paintbrush }
export const PlaybookIcon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const I = ICONS[name] ?? Rocket
  return <I size={size} />
}

/** Playbook cards grouped by category; picking one opens its short form. */
export function PlaybooksView({ initial, initialInputs }: { initial?: string; initialInputs?: Record<string, string> }) {
  const [open, setOpen] = useState<Playbook | null>(initial ? playbookById(initial) ?? null : null)
  if (open) return <PlaybookForm pb={open} preset={initialInputs} onBack={() => setOpen(null)} />
  const cats: PlaybookCategory[] = ['daily', 'upkeep', 'occasional']
  return (
    <div className="pb-wrap">
      {cats.map((c) => (
        <div key={c}>
          <div className="label" style={{ margin: '4px 0 10px' }}>
            {CATEGORY_LABEL[c]}
          </div>
          <div className="pb-grid">
            {PLAYBOOKS.filter((p) => p.category === c).map((p) => (
              <button key={p.id} className="pb-card" onClick={() => (p.panel ? useApp.getState().openPanel(p.panel) : setOpen(p))}>
                <span className="pb-icon">
                  <PlaybookIcon name={p.icon} />
                </span>
                <span className="pb-text">
                  <span className="pb-name">{p.name}</span>
                  <span className="pb-blurb">{p.blurb}</span>
                  <span className="pb-team">
                    <Users size={11} /> {p.team}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function PlaybookForm({ pb, preset, onBack }: { pb: Playbook; preset?: Record<string, string>; onBack: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(pb.inputs.map((i) => [i.key, preset?.[i.key] ?? i.value ?? ''])))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const project = useApp((s) => s.project)

  // last time's answers, unless the caller (Helm) filled them in
  useEffect(() => {
    if (preset) return
    lastInputs(pb.id).then((last) => setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, last[k] && pb.inputs.find((i) => i.key === k)?.kind !== 'textarea' ? last[k] : x]))))
  }, [pb.id])

  const run = async () => {
    const missing = pb.inputs.find((i) => !i.optional && i.kind !== 'switch' && !values[i.key]?.trim())
    if (missing) return setError(`${missing.label} is needed`)
    setBusy(true)
    try {
      await runPlaybook(pb.id, values)
      useApp.getState().closePanel()
    } catch (e: any) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div className="pb-form">
      <button className="btn ghost sm" onClick={onBack}>
        <ArrowLeft size={13} /> All playbooks
      </button>
      <div className="pb-form-head">
        <span className="pb-icon lg">
          <PlaybookIcon name={pb.icon} size={20} />
        </span>
        <div>
          <div className="pb-form-name">{pb.name}</div>
          <div className="muted">{pb.blurb}</div>
          <div className="pb-team" style={{ marginTop: 6 }}>
            <Users size={11} /> {pb.team} · on <b>{project?.name ?? 'no project'}</b>
          </div>
        </div>
      </div>
      {pb.inputs.map((i) =>
        i.kind === 'switch' ? (
          <div key={i.key} className="settings-rows" style={{ marginTop: 12 }}>
            <div className="settings-row">
              <div className="grow">{i.label}</div>
              <Switch on={!!values[i.key]} onChange={(on) => setValues({ ...values, [i.key]: on ? 'yes' : '' })} />
            </div>
          </div>
        ) : (
          <label key={i.key} className="pb-field">
            <span className="label">
              {i.label}
              {i.optional && <span className="dim"> · optional</span>}
            </span>
            {i.kind === 'textarea' ? (
              <textarea
                className="textarea"
                rows={3}
                autoFocus
                placeholder={i.placeholder}
                value={values[i.key]}
                onChange={(e) => (setValues({ ...values, [i.key]: e.target.value }), setError(''))}
                onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && run()}
              />
            ) : (
              <input
                className="input"
                placeholder={i.placeholder}
                value={values[i.key]}
                onChange={(e) => (setValues({ ...values, [i.key]: e.target.value }), setError(''))}
                onKeyDown={(e) => e.key === 'Enter' && run()}
              />
            )}
          </label>
        )
      )}
      {error && <div className="pb-error">{error}</div>}
      <div className="row" style={{ marginTop: 16 }}>
        <span className="muted small">A Lead plans it, the team does the work, and anything that needs you lands in your Inbox.</span>
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !project} onClick={run}>
          <Play size={13} /> {busy ? 'Starting…' : 'Run playbook'}
        </button>
      </div>
    </div>
  )
}
