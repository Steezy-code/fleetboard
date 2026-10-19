import { useState } from 'react'
import { ArrowRight, ImageDown, LoaderCircle, Locate, PenTool, Shapes, Square, Workflow, X } from 'lucide-react'
import { Seg } from '../ui/Modal'
import { useApp } from '../state/store'
import { BOARD_OVERLAYS } from '../board/BoardOverlays'
import { AgentPicker, resolveAgent, shortName, useHeadlessAgents } from './docs/AgentPicker'
import { PROJECT_DIAGRAMS, STARTERS } from './diagrams/presets'
import { exportExcalidraw, exportPng, focusFigureId, generateDiagram, placeDiagram, stopDiagram, useDiagramStudio } from './diagrams/state'
import { figureItems, figureTitle } from './diagrams/export'
import type { DiagramStyle } from './diagrams/toInk'
import '../styles/studios.css'

/**
 * Diagram studio: a compact floating card on the left of the board (the board stays usable).
 * Figures are drawn by your CLI from the repo, or inserted from starter shapes, as loose ink.
 */
export default function DiagramsStudio() {
  const planner = useApp((s) => s.settings.plannerAgent)
  const agents = useHeadlessAgents()
  const agentPref = useDiagramStudio((s) => s.agentId)
  const style = useDiagramStudio((s) => s.style)
  const busy = useDiagramStudio((s) => s.busy)
  const agent = resolveAgent(agentPref, agents, planner)
  const [describe, setDescribe] = useState('')

  // export target: the figure under the selection, else the most recent figure on this board
  const selectedFig = useApp((s) => {
    const ws = s.project?.workspaces.find((w) => w.id === s.project!.activeWorkspaceId)
    if (!ws || !s.selection.length) return null
    for (const id of s.selection) {
      const i = ws.ink.find((x) => x.id === id)
      if (i?.figureId) return i.figureId
    }
    return null
  })
  const lastFig = useApp((s) => {
    const ws = s.project?.workspaces.find((w) => w.id === s.project!.activeWorkspaceId)
    if (!ws) return null
    for (let k = ws.ink.length - 1; k >= 0; k--) if (ws.ink[k].figureId) return ws.ink[k].figureId!
    return null
  })
  const target = selectedFig ?? lastFig
  const targetTitle = useApp((s) => {
    const ws = s.project?.workspaces.find((w) => w.id === s.project!.activeWorkspaceId)
    return ws && target ? figureTitle(figureItems(ws.ink, target)) : ''
  })

  const run = (id: string, label: string, brief?: string, desc?: string) =>
    generateDiagram({ id, label, brief, describe: desc, agentId: agent.id, agentName: shortName(agent) })
  const sendDescribe = () => {
    const d = describe.trim()
    if (!d || busy) return
    run('describe', d.slice(0, 40), undefined, d)
    setDescribe('')
  }

  return (
    <div className="dg-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="dg-head">
        <span className="dg-head-ic">
          <Workflow size={14} />
        </span>
        <div className="grow">
          <div className="dg-title">Diagrams</div>
          <div className="dg-sub">Your repo, drawn by hand.</div>
        </div>
        <button className="icon-btn sm" onClick={() => useApp.getState().closePanel()} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="dg-body scrollable no-board-wheel">
        <div className="dg-sec">
          <div className="label">Model</div>
          <AgentPicker value={agent.id} onChange={(id) => useDiagramStudio.setState({ agentId: id })} disabled={!!busy} />
        </div>
        <div className="dg-sec">
          <div className="label">Style</div>
          <Seg<DiagramStyle>
            value={style}
            options={[
              { value: 'ink', label: 'Ink' },
              { value: 'colorful', label: 'Colorful' }
            ]}
            onChange={(v) => useDiagramStudio.setState({ style: v })}
          />
        </div>

        <div className="dg-sec">
          <div className="label">From your project</div>
          <div className="dg-grid">
            {PROJECT_DIAGRAMS.map((d) => {
              const Icon = d.icon
              const on = busy === d.id
              return (
                <button key={d.id} className={`dg-tile ${on ? 'busy' : ''}`} disabled={!!busy && !on} onClick={() => !busy && run(d.id, d.label, d.brief)}>
                  {on ? <LoaderCircle size={15} className="spin" /> : <Icon size={15} />}
                  <span>{d.label}</span>
                </button>
              )
            })}
          </div>
          <div className="dg-describe">
            <input
              className="input"
              placeholder="Describe a diagram…"
              value={describe}
              disabled={!!busy}
              onChange={(e) => setDescribe(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendDescribe()}
            />
            <button className="btn primary" disabled={!describe.trim() || !!busy} onClick={sendDescribe}>
              {busy === 'describe' ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />} Generate
            </button>
          </div>
          {busy && (
            <div className="dg-busy">
              <span className="status-dot pulse" style={{ ['--st' as any]: 'var(--accent)' }} />
              <span className="grow dg-busy-text">
                <b>{shortName(agent)} is drawing…</b>
                <Activity />
              </span>
              <button className="btn sm danger" onClick={stopDiagram}>
                <Square size={9} fill="currentColor" /> Stop
              </button>
            </div>
          )}
        </div>

        <div className="dg-sec">
          <div className="label">Starter shapes</div>
          <div className="dg-grid">
            {STARTERS.map((s) => {
              const Icon = s.icon
              return (
                <button key={s.id} className="dg-tile" onClick={() => placeDiagram(s.spec)}>
                  <Icon size={15} />
                  <span>{s.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="dg-sec dg-export">
          <div className="label">Export</div>
          {target ? (
            <>
              <div className="dg-target">
                <Shapes size={13} />
                <span className="grow" title={targetTitle}>
                  {targetTitle}
                </span>
                <span className="dg-target-tag">{selectedFig ? 'selected' : 'latest'}</span>
                <button className="icon-btn sm" title="Show on board" onClick={() => focusFigureId(target)}>
                  <Locate size={13} />
                </button>
              </div>
              <div className="row">
                <button className="btn grow" onClick={() => exportPng(target)}>
                  <ImageDown size={14} /> PNG
                </button>
                <button className="btn grow" onClick={() => exportExcalidraw(target)}>
                  <PenTool size={14} /> .excalidraw
                </button>
              </div>
            </>
          ) : (
            <div className="dg-hint">Generate a diagram or drop a starter shape, then export it as PNG or .excalidraw.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Activity() {
  const a = useDiagramStudio((s) => s.activity)
  return <span className="dg-activity mono">{a}</span>
}

/** "Claude is drawing…" pill on the board while a diagram is generated (even with the panel closed). */
function DrawingPill() {
  const busy = useDiagramStudio((s) => s.busy)
  const name = useDiagramStudio((s) => s.agentName)
  const label = useDiagramStudio((s) => s.busyLabel)
  if (!busy) return null
  return (
    <div className="dg-pill">
      <LoaderCircle size={13} className="spin" />
      <span>
        <b>{name} is drawing…</b> <span className="muted">{label}</span>
      </span>
      <button className="dg-pill-stop" onClick={stopDiagram} title="Stop">
        <Square size={8} fill="currentColor" />
      </button>
    </div>
  )
}
;(DrawingPill as any).__fbDiagramPill = true
{
  const i = BOARD_OVERLAYS.findIndex((c) => (c as any).__fbDiagramPill)
  if (i >= 0) BOARD_OVERLAYS.splice(i, 1, DrawingPill)
  else BOARD_OVERLAYS.push(DrawingPill)
}
