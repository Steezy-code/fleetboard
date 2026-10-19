import { useEffect, useMemo, useState } from 'react'
import { Bookmark, LayoutTemplate, Save, Trash2 } from 'lucide-react'
import { useApp } from '../state/store'
import { agentColor, agentLabel } from '../engine/consoles'
import { Modal } from '../ui/Modal'
import { useInstalledAgents } from '../orchestration/fleet'
import {
  BUILTIN_PRESETS,
  applySaved,
  loadSavedPresets,
  savedSchema,
  snapshotLayout,
  storeSavedPresets,
  type PresetDef,
  type SavedPreset,
  type SchemaRect
} from '../orchestration/presets'

function Schematic({ rects, wires }: { rects: SchemaRect[]; wires?: [number, number][] }) {
  const mid = (r: SchemaRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  return (
    <svg className="pre-schema" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet">
      {wires?.map(([a, b], i) => {
        const p = rects[a]
        const q = rects[b]
        if (!p || !q) return null
        const s = { x: p.x + p.w, y: mid(p).y }
        const e = { x: q.x, y: mid(q).y }
        const dx = (e.x - s.x) / 2
        return <path key={i} d={`M${s.x},${s.y} C${s.x + dx},${s.y} ${e.x - dx},${e.y} ${e.x},${e.y}`} className="pre-wire" />
      })}
      {rects.map((r, i) =>
        r.kind === 'orch' ? (
          <g key={i}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={3} className="pre-orch" />
            <circle cx={mid(r).x} cy={mid(r).y} r={Math.min(r.w, r.h) / 4} className="pre-orch-ring" />
          </g>
        ) : r.kind === 'team' ? (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={3} className="pre-team" />
        ) : (
          <g key={i}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.8} className={r.kind === 'console' ? 'pre-console' : 'pre-tile'} style={r.color ? { stroke: r.color } : undefined} />
            {r.kind === 'console' && r.h > 6 && (
              <>
                <rect x={r.x} y={r.y} width={r.w} height={Math.min(3, r.h / 4)} rx={1.2} className="pre-head" style={r.color ? { fill: r.color } : undefined} />
                {[0.42, 0.58, 0.74].map((f, j) =>
                  r.y + r.h * f < r.y + r.h - 1.5 ? (
                    <line key={j} x1={r.x + 2} x2={r.x + r.w * (0.8 - j * 0.18)} y1={r.y + r.h * f} y2={r.y + r.h * f} className="pre-line" />
                  ) : null
                )}
              </>
            )}
          </g>
        )
      )}
    </svg>
  )
}

/** Board presets: lay out a whole board in one tap, or save the current one. */
export default function PresetsPanel() {
  const installed = useInstalledAgents()
  const hasBoard = useApp((s) => {
    const ws = s.project?.workspaces.find((w) => w.id === s.project!.activeWorkspaceId)
    return !!ws && ws.nodes.length + ws.groups.length > 0
  })
  const [saved, setSaved] = useState<SavedPreset[]>([])
  const [naming, setNaming] = useState<string | null>(null)

  useEffect(() => {
    loadSavedPresets().then(setSaved)
  }, [])

  /** installed version of an agent: itself, else claude, else the first installed, else shell */
  const pick = useMemo(() => {
    const set = new Set(installed)
    const fallback = set.has('claude') ? 'claude' : installed.find((a) => a !== 'shell') ?? 'shell'
    return (want: string) => (set.has(want) ? want : fallback)
  }, [installed])

  const done = (label: string) => {
    const app = useApp.getState()
    app.closePanel()
    app.toast(`${label} laid out`, 'ok')
    window.setTimeout(() => useApp.getState().fitAll(), 80)
  }

  const applyBuiltin = (p: PresetDef) => {
    p.apply(pick)
    done(p.name)
  }

  const save = async () => {
    const name = (naming ?? '').trim() || `Layout ${saved.length + 1}`
    const snap = snapshotLayout(name)
    if (!snap) return useApp.getState().toast('The board is empty', 'warn')
    const list = [snap, ...saved]
    await storeSavedPresets(list)
    setSaved(list)
    setNaming(null)
    useApp.getState().toast(`Saved “${name}”`, 'ok')
  }

  const remove = async (p: SavedPreset) => {
    const ok = await useApp.getState().confirm({ title: `Delete preset “${p.name}”?`, body: 'Boards laid out from it stay as they are.', confirm: 'Delete', danger: true })
    if (!ok) return
    const list = saved.filter((x) => x.id !== p.id)
    await storeSavedPresets(list)
    setSaved(list)
  }

  return (
    <Modal
      title="Presets"
      sub="Lay out a board in one tap. Consoles start fresh with agents you have installed."
      icon={<LayoutTemplate size={17} />}
      width={860}
      footer={
        naming !== null ? (
          <>
            <input
              className="input"
              style={{ width: 280 }}
              autoFocus
              placeholder="Preset name"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => (e.key === 'Enter' ? save() : e.key === 'Escape' && setNaming(null))}
            />
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setNaming(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              <Save size={13} /> Save preset
            </button>
          </>
        ) : (
          <>
            <span className="muted small">Saves node types, positions, teams and wires. No running processes.</span>
            <span className="spacer" />
            <button className="btn" disabled={!hasBoard} onClick={() => setNaming('')}>
              <Bookmark size={13} /> Save current layout as preset
            </button>
          </>
        )
      }
    >
      <div className="pre-grid">
        {BUILTIN_PRESETS.map((p) => (
          <button key={p.id} className="pre-card" onClick={() => applyBuiltin(p)}>
            <div className="pre-preview">
              <Schematic rects={p.schema} wires={p.wires} />
            </div>
            <div className="pre-name">{p.name}</div>
            <div className="pre-blurb">{p.blurb}</div>
            <div className="pre-agents">
              {p.agents.length ? (
                [...new Set(p.agents.map(pick))].map((a) => (
                  <span key={a} className="pre-agent" title={agentLabel(a)}>
                    <span className="agent-dot" style={{ background: agentColor(a), width: 7, height: 7 }} />
                    {p.agents.map(pick).filter((x) => x === a).length}× {agentLabel(a)}
                  </span>
                ))
              ) : (
                <span className="pre-agent dim">no consoles</span>
              )}
            </div>
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <>
          <div className="label" style={{ margin: '20px 0 10px' }}>
            Saved presets
          </div>
          <div className="pre-grid">
            {saved.map((p) => (
              <div key={p.id} className="pre-card saved" role="button" onClick={() => (applySaved(p, pick), done(p.name))}>
                <button
                  className="icon-btn sm pre-del"
                  title="Delete preset"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(p)
                  }}
                >
                  <Trash2 size={13} />
                </button>
                <div className="pre-preview">
                  <Schematic rects={savedSchema(p)} />
                </div>
                <div className="pre-name">{p.name}</div>
                <div className="pre-blurb">
                  {p.nodes.filter((n) => n.type === 'console').length} consoles · {p.groups.length} teams · {p.nodes.filter((n) => n.type !== 'console').length} tiles
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
