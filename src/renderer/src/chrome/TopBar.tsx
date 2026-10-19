import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Briefcase, ChevronDown, Folder, Minus, Plus, Settings, Square, X } from 'lucide-react'
import { invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { UsagePill } from './UsagePill'

export function TopBar() {
  const project = useApp((s) => s.project)!
  const projects = useApp((s) => s.projects)
  const live = useApp((s) => s.live)
  const statuses = useApp((s) => s.statuses)
  const liveCount = Object.keys(live).length
  const needsYou = Object.entries(statuses).filter(([id, st]) => st === 'needs-you' && live[id]).length
  const [projMenu, setProjMenu] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const app = useApp.getState()
  const pendingResume = allConsoles().filter((c) => !live[c.id] && c.data.launch === 'ask').length

  return (
    <div className="topbar">
      <button className="btn ghost sm no-drag" onClick={() => app.closeProject()}>
        <ArrowLeft size={14} /> Back to home
      </button>
      <div className="no-drag" style={{ position: 'relative' }}>
        <button className="btn ghost sm" onClick={() => setProjMenu(!projMenu)}>
          <Folder size={13} /> {project.name} <ChevronDown size={12} />
        </button>
        {projMenu && (
          <div className="menu" style={{ top: 32, left: 0, width: 280 }} onMouseLeave={() => setProjMenu(false)}>
            <div className="menu-label label">Projects</div>
            {projects.map((p) => (
              <button
                key={p.id}
                className={`menu-item ${p.id === project.id ? 'on' : ''}`}
                onClick={() => {
                  setProjMenu(false)
                  app.closeProject()
                  app.openProject(p.path)
                }}
              >
                <Folder size={13} className="ic" />
                <span className="grow">{p.name}</span>
                <span className="dim mono" style={{ fontSize: 11 }}>
                  {p.consoles}
                </span>
              </button>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={async () => {
                setProjMenu(false)
                const dir = await invoke<string | null>('dialog:openFolder')
                if (dir) {
                  app.closeProject()
                  app.openProject(dir)
                }
              }}
            >
              <Plus size={13} className="ic" /> Open folder…
            </button>
          </div>
        )}
      </div>
      <div className="ws-tabs no-drag">
        {project.workspaces.map((w) => {
          const active = w.id === project.activeWorkspaceId
          const count = w.nodes.filter((n) => n.type === 'console' && live[n.id]).length
          return (
            <div
              key={w.id}
              className={`ws-tab ${active ? 'on' : ''}`}
              onClick={() => app.switchWorkspace(w.id)}
              onDoubleClick={() => setRenaming(w.id)}
            >
              {renaming === w.id ? (
                <RenameInput
                  value={w.name}
                  onDone={(v) => {
                    app.renameWorkspace(w.id, v || w.name)
                    setRenaming(null)
                  }}
                />
              ) : (
                <span>{w.name}</span>
              )}
              {count > 0 && <span className="ws-badge">{count}</span>}
              {project.workspaces.length > 1 && (
                <button
                  className="ws-x"
                  onClick={async (e) => {
                    e.stopPropagation()
                    const consoles = w.nodes.filter((n) => n.type === 'console' && live[n.id])
                    if (
                      consoles.length &&
                      !(await app.confirm({ title: `Close ${w.name}?`, body: `${consoles.length} console(s) keep running until you close them.`, confirm: 'Close workspace' }))
                    )
                      return
                    for (const c of consoles) invoke('pty:kill', c.id)
                    app.closeWorkspace(w.id)
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}
        <button className="icon-btn sm" title="New workspace" onClick={() => app.addWorkspace()}>
          <Plus size={14} />
        </button>
      </div>
      <button className="btn ghost sm no-drag" onClick={() => app.closeProject()}>
        <X size={13} /> Close
      </button>

      <div className="spacer drag" />

      {pendingResume > 0 && (
        <div className="resume-banner no-drag">
          <span>
            Resume {pendingResume === 1 ? 'the last conversation' : `all ${pendingResume} conversations`}?
          </span>
          <button className="btn sm primary" onClick={() => resumeAll(true)}>
            Yes
          </button>
          <button className="btn sm" onClick={() => resumeAll(false)}>
            No
          </button>
        </div>
      )}
      {needsYou > 0 && (
        <button className="needs-badge no-drag" onClick={() => app.openPanel('missionMap', { filter: 'needs-you' })}>
          <span className="dot" style={{ background: 'var(--warn)' }} /> {needsYou} need{needsYou === 1 ? 's' : ''} you
        </button>
      )}
      <div className="live-count no-drag" title="Consoles with a running process" onClick={() => app.openPanel('missionMap')}>
        <span className="dot live" /> {liveCount} live
      </div>
      <div className="no-drag">
        <UsagePill />
      </div>
      <button className="icon-btn no-drag" title="Accounts" onClick={() => app.openDrawer('accounts')}>
        <Briefcase size={15} />
      </button>
      <button className="icon-btn no-drag" title="Settings" onClick={() => app.openPanel('settings')}>
        <Settings size={15} />
      </button>
      <WindowControls />
    </div>
  )
}

/** Answer the reopen prompt for every console waiting on it. */
function resumeAll(yes: boolean) {
  const app = useApp.getState()
  for (const c of allConsoles()) {
    if (!app.live[c.id] && c.data.launch === 'ask') {
      // the console node (now or when its workspace is shown) launches accordingly
      updateConsoleLaunch(c.workspaceId, c.id, yes ? 'resume' : 'fresh')
    }
  }
}

function updateConsoleLaunch(workspaceId: string, id: string, launch: 'resume' | 'fresh') {
  const p = useApp.getState().project!
  const project = {
    ...p,
    workspaces: p.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, nodes: w.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, launch } } : n)) } : w
    )
  }
  useApp.setState({ project })
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  return (
    <input
      ref={ref}
      className="title-input"
      defaultValue={value}
      onBlur={(e) => onDone(e.target.value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

export function WindowControls() {
  return (
    <div className="win-controls no-drag">
      <button className="icon-btn sm" onClick={() => invoke('win:minimize')}>
        <Minus size={13} />
      </button>
      <button className="icon-btn sm" onClick={() => invoke('win:maximize')}>
        <Square size={11} />
      </button>
      <button className="icon-btn sm close" onClick={() => invoke('win:close')}>
        <X size={14} />
      </button>
    </div>
  )
}
