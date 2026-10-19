import { useMemo } from 'react'
import { ArrowRight, FolderOpen, FolderPlus, Settings, Sunrise, X } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { WindowControls } from './TopBar'

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Launcher: recent projects, open a folder, which agent CLIs are installed. */
export function Home() {
  const projects = useApp((s) => s.projects)
  const agents = useApp((s) => s.agents)
  const app = useApp.getState()
  const installed = useMemo(() => AGENTS.filter((a) => agents.find((x) => x.id === a.id && x.path) && a.id !== 'shell'), [agents])

  const open = async () => {
    const dir = await invoke<string | null>('dialog:openFolder')
    if (dir) app.openProject(dir)
  }

  return (
    <div className="home">
      <div className="home-top drag">
        <div className="brand no-drag">
          <span className="brand-mark" />
          Fleetboard
        </div>
        <span className="spacer" />
        <button className="icon-btn no-drag" onClick={() => app.openPanel('settings')}>
          <Settings size={15} />
        </button>
        <WindowControls />
      </div>
      <div className="home-main">
        <div className="home-hero">
          <div className="eyebrow">A visual board for your coding agents</div>
          <h1>
            Don't let a screen <em>decide</em> how many agents you run.
          </h1>
          <p className="muted">
            Real terminals running Claude Code, Codex, Gemini and {AGENTS.length - 4} more, on one board you can pan, zoom, group and talk to.
            Everything runs on your machine, on your own subscriptions.
          </p>
          <div className="row" style={{ gap: 10, marginTop: 22 }}>
            <button className="btn primary" style={{ height: 38, padding: '0 18px' }} onClick={open}>
              <FolderPlus size={15} /> Open a repo
            </button>
            <button className="btn home-sweep-btn" style={{ height: 38, padding: '0 16px' }} onClick={() => app.openPanel('sweep')} title="Read-only health check across all your repos">
              <Sunrise size={15} /> Morning sweep
            </button>
            {projects[0] && (
              <button className="btn" style={{ height: 38, padding: '0 16px' }} onClick={() => app.openProject(projects[0].path)}>
                Continue {projects[0].name} <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="home-cols">
          <div className="home-section">
            <div className="label">Recent boards</div>
            {projects.length === 0 && <div className="muted" style={{ padding: '14px 0' }}>Point Fleetboard at a folder and it becomes a board.</div>}
            <div className="project-list">
              {projects.map((p) => (
                <div key={p.id} className="project-card" onClick={() => app.openProject(p.path)}>
                  <FolderOpen size={17} className="pc-icon" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="pc-name">{p.name}</div>
                    <div className="pc-path mono">{p.path.replace(/^\/home\/[^/]+/, '~')}</div>
                  </div>
                  <div className="pc-meta">
                    <div>{p.consoles} console{p.consoles === 1 ? '' : 's'}</div>
                    <div className="dim">{ago(p.lastOpened)}</div>
                  </div>
                  <button
                    className="icon-btn sm pc-x"
                    title="Remove from list"
                    onClick={async (e) => {
                      e.stopPropagation()
                      await invoke('store:forgetProject', p.id)
                      useApp.setState({ projects: projects.filter((x) => x.id !== p.id) })
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="home-section">
            <div className="label">Agents on your PATH</div>
            <div className="agent-chips">
              {installed.map((a) => (
                <span key={a.id} className="agent-chip">
                  <span className="dot" style={{ background: a.color }} />
                  {a.name}
                </span>
              ))}
              {!installed.length && <span className="muted">Scanning…</span>}
            </div>
            <div className="first-run">
              <div className="fr-step">
                <span>1</span>
                <div>
                  <b>Install your CLIs.</b> Sign in to Claude Code, Codex, Gemini or whichever agents you use, as usual.
                </div>
              </div>
              <div className="fr-step">
                <span>2</span>
                <div>
                  <b>Open a repo.</b> It becomes a board with workspaces you switch like tabs.
                </div>
              </div>
              <div className="fr-step">
                <span>3</span>
                <div>
                  <b>Spawn consoles.</b> Direct them by voice or keyboard, group them into teams, or leave them on a loop.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
