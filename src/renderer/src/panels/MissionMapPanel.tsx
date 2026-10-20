import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Frame, Map as MapIcon, Pause, Play, Search, Send, Spline, Trash2 } from 'lucide-react'
import { pairs } from '@shared/seq'
import type { ConsoleStatus, PtyInfo } from '@shared/types'
import { ROLE_TINT } from '@shared/types'
import { CAN_PAUSE, invoke } from '../lib/api'
import { useApp } from '../state/store'
import { agentColor, agentLabel, killConsoles, pauseAll, resumeAll } from '../engine/consoles'
import { Modal } from '../ui/Modal'
import {
  BUCKET_LABEL,
  STATUS_TEXT,
  bucketOf,
  fmtDuration,
  goToItem,
  plural,
  statusOf,
  useFleet,
  type Bucket,
  type FleetConsole,
  type FleetOrchestrator,
  type FleetTeam
} from '../orchestration/fleet'
import { AgentAvatar } from '../orchestration/OrchestratorView'
import { startConnect } from '../orchestration/connect'

type Filter = 'all' | Bucket
type Sel = { kind: 'console' | 'team' | 'orch' | 'root'; id: string } | null

const FILTERS: Filter[] = ['all', 'working', 'needs-you', 'idle', 'done']
const BUCKET_COLOR: Record<Bucket, string> = { working: 'var(--accent)', 'needs-you': 'var(--warn)', idle: 'var(--ok)', done: '#60a5fa' }

// layout (graph px)
const COL0 = { x: 20, w: 176, h: 58 }
const COL1 = { x: 262, w: 204, h: 54 }
const COL2 = { x: 534, w: 272 }
const ROW_H = 30
const ROW_GAP = 6
const SECTION_GAP = 22
const TOP = 18
const GRAPH_W = COL2.x + COL2.w + 16
// below this the labels get hard to read, so the map fits its width and scrolls down instead
const MIN_FIT = 0.7

interface Section {
  key: string
  team?: FleetTeam
  rows: FleetConsole[]
  y: number
  h: number
  parents: string[]
}

interface LeftNode {
  key: string
  kind: 'orch' | 'root'
  orch?: FleetOrchestrator
  y: number
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = (x2 - x1) * 0.5
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}

export default function MissionMapPanel({ filter: initialFilter }: { filter?: Filter }) {
  const fleet = useFleet()
  const statuses = useApp((s) => s.statuses)
  const live = useApp((s) => s.live)
  const projectName = useApp((s) => s.project?.name ?? 'Board')
  const loopsActive = useApp((s) => ((s.project?.extras.loops as any[]) ?? []).filter((l) => l.enabled).length)
  const [filter, setFilter] = useState<Filter>(initialFilter ?? 'all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Sel>(null)
  const [ptys, setPtys] = useState<Record<string, PtyInfo>>({})
  const [, setNow] = useState(0)
  const graphRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState({ w: GRAPH_W, h: 600 })

  useEffect(() => {
    const el = graphRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth - 24, h: el.clientHeight - 12 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const load = () => invoke<PtyInfo[]>('pty:list').then((l) => setPtys(Object.fromEntries(l.map((p) => [p.id, p]))))
    load()
    const t = window.setInterval(() => (load(), setNow(Date.now())), 4000)
    return () => window.clearInterval(t)
  }, [])

  const st = (id: string): ConsoleStatus => statusOf(statuses, live, id)

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { working: 0, 'needs-you': 0, idle: 0, done: 0 }
    for (const x of fleet.consoles) c[bucketOf(statusOf(statuses, live, x.id))]++
    return c
  }, [fleet, statuses, live])

  // ---------- layout ----------
  const layout = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const teamById = new Map(fleet.teams.map((t) => [t.id, t]))
    const match = (c: FleetConsole) => {
      if (filter !== 'all' && bucketOf(statusOf(statuses, live, c.id)) !== filter) return false
      if (!ql) return true
      const t = c.groupId ? teamById.get(c.groupId) : undefined
      return [c.name, agentLabel(c.agentId), t?.name ?? '', t?.role ?? '', c.workspaceName].some((s) => s.toLowerCase().includes(ql))
    }
    const visible = fleet.consoles.filter(match)

    // which orchestrators feed each team / console
    const parentsOf = new Map<string, string[]>()
    for (const o of fleet.orchestrators) for (const id of o.wiredIds) parentsOf.set(id, [...(parentsOf.get(id) ?? []), o.id])

    const sections: Omit<Section, 'y' | 'h'>[] = []
    const teamsOrdered = [...fleet.teams].sort((a, b) => {
      const ia = fleet.orchestrators.findIndex((o) => o.wiredIds.includes(a.id))
      const ib = fleet.orchestrators.findIndex((o) => o.wiredIds.includes(b.id))
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    })
    for (const t of teamsOrdered) {
      const rows = visible.filter((c) => c.groupId === t.id)
      const teamMatches = !ql || t.name.toLowerCase().includes(ql) || t.role.toLowerCase().includes(ql)
      if (!rows.length && !(filter === 'all' && teamMatches && (!ql || !t.memberIds.length))) continue
      sections.push({ key: t.id, team: t, rows, parents: parentsOf.get(t.id) ?? [] })
    }
    const loose = visible.filter((c) => !c.groupId || !teamById.has(c.groupId))
    if (loose.length) sections.push({ key: 'loose', rows: loose, parents: [] })

    let y = TOP
    const placed: Section[] = sections.map((s) => {
      const n = Math.max(1, s.rows.length)
      const h = n * ROW_H + (n - 1) * ROW_GAP
      const sec = { ...s, y, h: Math.max(h, COL1.h) }
      y += sec.h + SECTION_GAP
      return sec
    })

    // a console wired straight to an orchestrator counts as its child too
    const directRows = new Map<string, string[]>()
    for (const s of placed) for (const r of s.rows) if (parentsOf.has(r.id)) directRows.set(r.id, parentsOf.get(r.id)!)

    const needsRoot = !fleet.orchestrators.length || placed.some((s) => !s.parents.length)
    const lefts: LeftNode[] = fleet.orchestrators.map((o) => ({ key: o.id, kind: 'orch' as const, orch: o, y: 0 }))
    if (needsRoot) lefts.push({ key: 'root', kind: 'root', y: 0 })
    const rowY = (s: Section, i: number) => s.y + (s.h - (Math.max(1, s.rows.length) * ROW_H + (Math.max(1, s.rows.length) - 1) * ROW_GAP)) / 2 + i * (ROW_H + ROW_GAP) + ROW_H / 2
    for (const l of lefts) {
      const ys: number[] = []
      for (const s of placed) {
        if (l.kind === 'root' ? !s.parents.length : s.parents.includes(l.key)) ys.push(s.y + s.h / 2)
        if (l.kind === 'orch') s.rows.forEach((r, i) => directRows.get(r.id)?.includes(l.key) && ys.push(rowY(s, i)))
      }
      l.y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : TOP + COL0.h / 2
    }
    // keep left nodes apart
    const sorted = [...lefts].sort((a, b) => a.y - b.y)
    for (const [above, below] of pairs(sorted)) below.y = Math.max(below.y, above.y + COL0.h + 16)
    const highest = sorted[0]
    if (highest && highest.y < TOP + COL0.h / 2) {
      const d = TOP + COL0.h / 2 - highest.y
      sorted.forEach((l) => (l.y += d))
    }
    const height = Math.max(y, ...lefts.map((l) => l.y + COL0.h / 2 + 20), 200)
    return { sections: placed, lefts, directRows, rowY, height, visibleCount: visible.length }
  }, [fleet, filter, q, statuses, live])

  // ---------- edges ----------
  const edges = useMemo(() => {
    type Tone = 'hot' | 'warn' | 'dim' | 'cool'
    const out: { key: string; d: string; tone: Tone }[] = []
    const toneOf = (ids: string[]): Tone => {
      const ss = ids.map(st)
      return ss.includes('working') ? 'hot' : ss.includes('needs-you') ? 'warn' : ss.some((s) => s === 'idle' || s === 'starting') ? 'cool' : 'dim'
    }
    for (const l of layout.lefts) {
      for (const s of layout.sections) {
        const linked = l.kind === 'root' ? !s.parents.length : s.parents.includes(l.key)
        if (linked) {
          const ids = s.team ? s.team.memberIds : s.rows.map((r) => r.id)
          out.push({ key: `${l.key}-${s.key}`, d: curve(COL0.x + COL0.w, l.y, COL1.x, s.y + s.h / 2), tone: toneOf(ids) })
        }
        if (l.kind === 'orch')
          s.rows.forEach((r, i) => {
            if (layout.directRows.get(r.id)?.includes(l.key))
              out.push({ key: `${l.key}-${r.id}`, d: curve(COL0.x + COL0.w, l.y, COL2.x, layout.rowY(s, i)), tone: toneOf([r.id]) })
          })
      }
    }
    for (const s of layout.sections) {
      s.rows.forEach((r, i) => {
        const status = st(r.id)
        const tone = status === 'working' ? 'hot' : status === 'needs-you' ? 'warn' : status === 'idle' || status === 'starting' ? 'cool' : 'dim'
        out.push({ key: `${s.key}-${r.id}`, d: curve(COL1.x + COL1.w, s.y + s.h / 2, COL2.x, layout.rowY(s, i)), tone })
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, statuses, live])

  // scale the whole graph to the space it has: never larger than 1:1, never so small it's unreadable
  const sW = Math.min(1, avail.w / GRAPH_W)
  const scale = Math.max(Math.min(sW, avail.h / layout.height), Math.min(sW, MIN_FIT))

  const workingCount = counts.working
  const teamsCount = fleet.teams.length
  const sub = `${plural(fleet.orchestrators.length, 'orchestrator')} · ${plural(teamsCount, 'team')} · ${plural(fleet.consoles.length, 'console')} · ${workingCount} working`

  return (
    <Modal
      title="Mission Map"
      sub={sub}
      icon={<MapIcon size={17} />}
      width="min(1320px, calc(100vw - 48px))"
      height="min(860px, calc(100vh - 96px))"
      bare
      footer={
        <div className="mm-legend">
          {(['working', 'needs-you', 'idle', 'starting', 'paused', 'done', 'exited'] as ConsoleStatus[]).map((s) => (
            <span key={s} className={`row st-${s}`} style={{ gap: 6 }}>
              <span className="status-dot" />
              {STATUS_TEXT[s]}
            </span>
          ))}
          <span className="spacer" />
          <span className="dim small">Click to inspect · double-click to go to it</span>
        </div>
      }
    >
      <div className="mm">
        <div className="mm-main">
          <div className="mm-toolbar">
            {FILTERS.map((f) => {
              const n = f === 'all' ? fleet.consoles.length : counts[f]
              return (
                <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                  {f !== 'all' && <span className="dot" style={{ background: filter === f ? '#fff' : BUCKET_COLOR[f] }} />}
                  {f === 'all' ? 'All' : BUCKET_LABEL[f]}
                  <span className="mm-chip-n">{n}</span>
                </button>
              )
            })}
            <span className="spacer" />
            <div className="mm-search">
              <Search size={13} />
              <input className="input" placeholder="Find a console or team" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div ref={graphRef} className="mm-graph scrollable" onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}>
            {!fleet.consoles.length && !fleet.teams.length ? (
              <div className="empty">
                <div>Nothing on the board yet.</div>
                <button className="btn sm primary" onClick={() => useApp.getState().openPanel('composer')}>
                  Compose a team
                </button>
              </div>
            ) : (
              <div className="mm-fit" style={{ width: GRAPH_W * scale, height: layout.height * scale }}>
                <div className="mm-canvas" style={{ width: GRAPH_W, height: layout.height, transform: scale === 1 ? undefined : `scale(${scale})` }}>

                  <svg className="mm-edges" width={GRAPH_W} height={layout.height}>
                    {edges.map((e) => (
                      <path key={e.key} d={e.d} className={`mm-edge ${e.tone}`} />
                    ))}
                  </svg>
                  {layout.lefts.map((l) => {
                    const on = sel?.id === l.key
                    const style = { left: COL0.x, top: l.y - COL0.h / 2, width: COL0.w, height: COL0.h }
                    if (l.kind === 'root')
                      return (
                        <div key="root" className={`mm-node mm-root ${on ? 'on' : ''}`} style={style} onClick={() => setSel({ kind: 'root', id: 'root' })}>
                          <span className="mm-ring dim">▣</span>
                          <span className="grow">
                            <span className="mm-node-title">{projectName}</span>
                            <span className="mm-node-sub">{fleet.orchestrators.length ? 'not orchestrated' : 'board'}</span>
                          </span>
                        </div>
                      )
                    const o = l.orch!
                    return (
                      <div
                        key={o.id}
                        className={`mm-node mm-orch ${on ? 'on' : ''}`}
                        style={style}
                        onClick={() => setSel({ kind: 'orch', id: o.id })}
                        onDoubleClick={() => goToItem(o.id, o.workspaceId)}
                      >
                        <span className="mm-ring">◎</span>
                        <span className="grow">
                          <span className="mm-node-title">{o.title}</span>
                          <span className="mm-node-sub">{o.wiredIds.length ? plural(o.wiredIds.length, 'wire') : 'not wired'}{fleet.multiWs ? ` · ${o.workspaceName}` : ''}</span>
                        </span>
                      </div>
                    )
                  })}
                  {layout.sections.map((s) => {
                    const tint = s.team ? ROLE_TINT[s.team.role] : 'var(--muted)'
                    const ids = s.team ? s.team.memberIds : s.rows.map((r) => r.id)
                    const w = ids.filter((id) => st(id) === 'working').length
                    const nyou = ids.filter((id) => st(id) === 'needs-you').length
                    const on = sel?.id === s.key
                    return (
                      <div key={s.key}>
                        <div
                          className={`mm-node mm-team ${on ? 'on' : ''} ${s.team ? '' : 'loose'}`}
                          style={{ left: COL1.x, top: s.y + s.h / 2 - COL1.h / 2, width: COL1.w, height: COL1.h, ['--tint' as any]: tint }}
                          onClick={() => s.team && setSel({ kind: 'team', id: s.team.id })}
                          onDoubleClick={() => s.team && goToItem(s.team.id, s.team.workspaceId)}
                        >
                          <span className="dot" style={{ background: tint }} />
                          <span className="grow">
                            <span className="mm-team-name">{s.team ? s.team.name : 'Loose consoles'}</span>
                            <span className="mm-node-sub">
                              {plural(ids.length, 'console')}
                              {nyou ? ` · ${nyou} need you` : w ? ` · ${w} working` : ''}
                              {fleet.multiWs && s.team ? ` · ${s.team.workspaceName}` : ''}
                            </span>
                          </span>
                        </div>
                        {!s.rows.length && (
                          <div className="mm-row placeholder" style={{ left: COL2.x, top: layout.rowY(s, 0) - ROW_H / 2, width: COL2.w, height: ROW_H }}>
                            {s.team?.memberIds.length ? 'no matching consoles' : 'empty team'}
                          </div>
                        )}
                        {s.rows.map((r, i) => {
                          const status = st(r.id)
                          return (
                            <div
                              key={r.id}
                              className={`mm-row st-${status} ${sel?.id === r.id ? 'on' : ''}`}
                              style={{ left: COL2.x, top: layout.rowY(s, i) - ROW_H / 2, width: COL2.w, height: ROW_H }}
                              onClick={() => setSel({ kind: 'console', id: r.id })}
                              onDoubleClick={() => goToItem(r.id, r.workspaceId)}
                            >
                              <span className="status-dot" />
                              <span className="mm-row-name">{r.name}</span>
                              <span className="mm-row-agent">
                                <span className="agent-dot" style={{ background: agentColor(r.agentId), width: 7, height: 7 }} />
                                {agentLabel(r.agentId)}
                              </span>
                              <span className="spacer" />
                              <span className="mm-row-status">{STATUS_TEXT[status]}</span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                  {!layout.visibleCount && filter !== 'all' && (
                    <div className="mm-none">No consoles are {BUCKET_LABEL[filter as Bucket].toLowerCase()} right now.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <aside className="mm-side scrollable">
          <div className="mm-card">
            <div className="label">Fleet</div>
            {(['working', 'needs-you', 'idle', 'done'] as Bucket[]).map((b) => (
              <button key={b} className={`mm-stat ${filter === b ? 'on' : ''}`} onClick={() => setFilter(filter === b ? 'all' : b)}>
                <span className="dot" style={{ background: BUCKET_COLOR[b] }} />
                <span className="grow">{BUCKET_LABEL[b]}</span>
                <span className="mm-stat-n">{counts[b]}</span>
              </button>
            ))}
          </div>
          <div className="mm-card">
            <div className="label">Structure</div>
            <div className="mm-stat static">
              <span className="grow">Orchestrators</span>
              <span className="mm-stat-n">{fleet.orchestrators.length}</span>
            </div>
            <div className="mm-stat static">
              <span className="grow">Teams</span>
              <span className="mm-stat-n">{teamsCount}</span>
            </div>
            <div className="mm-stat static">
              <span className="grow">Consoles</span>
              <span className="mm-stat-n">{fleet.consoles.length}</span>
            </div>
            <button className="mm-stat" onClick={() => useApp.getState().openPanel('loops')}>
              <span className="grow">Active loops</span>
              <span className="mm-stat-n">{loopsActive}</span>
            </button>
          </div>
          <Details sel={sel} fleet={fleet} st={st} ptys={ptys} onClear={() => setSel(null)} />
        </aside>
      </div>
    </Modal>
  )
}

function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="mm-kv">
      <span className="muted">{k}</span>
      <span className="mm-kv-v">{v}</span>
    </div>
  )
}

function Details({
  sel,
  fleet,
  st,
  ptys,
  onClear
}: {
  sel: Sel
  fleet: ReturnType<typeof useFleet>
  st: (id: string) => ConsoleStatus
  ptys: Record<string, PtyInfo>
  onClear: () => void
}) {
  const app = useApp.getState()
  if (!sel || sel.kind === 'root')
    return (
      <div className="mm-card mm-hint">
        <div className="label">Selection</div>
        <div className="muted small">Pick a console, team or orchestrator in the map to see its details and act on it.</div>
      </div>
    )

  if (sel.kind === 'console') {
    const c = fleet.consoles.find((x) => x.id === sel.id)
    if (!c) return null
    const status = st(c.id)
    const team = fleet.teams.find((t) => t.id === c.groupId)
    const pty = ptys[c.id]
    const live = !!app.live[c.id]
    return (
      <div className="mm-card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <AgentAvatar agentId={c.agentId} size={30} />
          <div className="grow">
            <div className="mm-detail-title">{c.name}</div>
            <span className={`st-${status}`}>
              <span className="status-pill">
                <span className="status-dot" />
                {STATUS_TEXT[status]}
              </span>
            </span>
          </div>
        </div>
        <DetailRow k="Agent" v={agentLabel(c.agentId)} />
        <DetailRow k="Status" v={STATUS_TEXT[status]} />
        <DetailRow k="Team" v={team ? team.name : '—'} />
        <DetailRow k="Workspace" v={c.workspaceName} />
        <DetailRow k="Uptime" v={pty && live ? fmtDuration(Date.now() - pty.startedAt) : 'not running'} />
        <div className="mm-actions">
          <button className="btn primary" onClick={() => goToItem(c.id, c.workspaceId)}>
            Go to the console <ArrowRight size={14} />
          </button>
          <div className="row">
            {live && CAN_PAUSE && (
              <button className="btn sm grow" onClick={() => invoke(status === 'paused' ? 'pty:resume' : 'pty:pause', c.id)}>
                {status === 'paused' ? <Play size={12} /> : <Pause size={12} />}
                {status === 'paused' ? 'Resume' : 'Pause'}
              </button>
            )}
            <button className="btn sm grow" onClick={() => app.openPanel('handoff', { from: [c.id] })}>
              <Send size={12} /> Hand off
            </button>
            <button
              className="btn sm grow mm-kill"
              onClick={async () => {
                const s = useApp.getState()
                if (s.project && s.project.activeWorkspaceId !== c.workspaceId) s.switchWorkspace(c.workspaceId)
                if (await killConsoles([c.id])) onClear()
              }}
            >
              <Trash2 size={12} /> Kill
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (sel.kind === 'team') {
    const t = fleet.teams.find((x) => x.id === sel.id)
    if (!t) return null
    const ss = t.memberIds.map(st)
    const paused = ss.length > 0 && ss.every((s) => s === 'paused')
    return (
      <div className="mm-card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="mm-team-badge" style={{ background: ROLE_TINT[t.role] }}>
            {t.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="grow">
            <div className="mm-detail-title">{t.name}</div>
            <div className="muted small">{t.role} team</div>
          </div>
        </div>
        <DetailRow k="Consoles" v={t.memberIds.length} />
        <DetailRow k="Working" v={ss.filter((s) => s === 'working').length} />
        <DetailRow k="Needs you" v={ss.filter((s) => s === 'needs-you').length} />
        <DetailRow k="Workspace" v={t.workspaceName} />
        <DetailRow k="Agents" v={[...new Set(fleet.consoles.filter((c) => c.groupId === t.id).map((c) => agentLabel(c.agentId)))].join(', ') || '—'} />
        <div className="mm-actions">
          <button className="btn primary" onClick={() => goToItem(t.id, t.workspaceId)}>
            <Frame size={14} /> Frame the team on the board
          </button>
          <div className="row">
            {CAN_PAUSE && (
              <button className="btn sm grow" disabled={!t.memberIds.length} onClick={() => (paused ? resumeAll(t.memberIds) : pauseAll(t.memberIds))}>
                {paused ? <Play size={12} /> : <Pause size={12} />}
                {paused ? 'Resume team' : 'Pause team'}
              </button>
            )}
            <button className="btn sm grow" disabled={!t.memberIds.length} onClick={() => app.openPanel('handoff', { from: t.memberIds })}>
              <Send size={12} /> Hand off
            </button>
          </div>
        </div>
      </div>
    )
  }

  const o = fleet.orchestrators.find((x) => x.id === sel.id)
  if (!o) return null
  const teams = fleet.teams.filter((t) => o.wiredIds.includes(t.id))
  return (
    <div className="mm-card">
      <div className="row" style={{ gap: 10, marginBottom: 6 }}>
        <span className="mm-ring big">◎</span>
        <div className="grow">
          <div className="mm-detail-title">{o.title}</div>
          <div className="muted small">{o.workspaceName}</div>
        </div>
      </div>
      <DetailRow k="Teams wired" v={teams.map((t) => t.name).join(', ') || '—'} />
      <DetailRow k="Consoles wired" v={fleet.consoles.filter((c) => o.wiredIds.includes(c.id)).length} />
      <div className="mm-actions">
        <button className="btn primary" onClick={() => goToItem(o.id, o.workspaceId)}>
          Go to the orchestrator <ArrowRight size={14} />
        </button>
        <button
          className="btn sm"
          onClick={() => {
            goToItem(o.id, o.workspaceId)
            window.setTimeout(() => startConnect(o.id), 80)
          }}
        >
          <Spline size={12} /> Connect more
        </button>
      </div>
    </div>
  )
}

