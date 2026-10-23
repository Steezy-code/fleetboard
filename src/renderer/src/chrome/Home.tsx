import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, CircleAlert, Copy, FolderOpen, FolderPlus, RefreshCw, Settings, Sunrise, X } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { WindowControls } from './TopBar'
import { MAIN_AGENTS, readinessOf, type Readiness, type SignIn } from './readiness'
import type { AgentDef } from '@shared/types'

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
  const recent = projects[0]
  const app = useApp.getState()
  const ready = useReadiness().some(([, r]) => r.state === 'ready')

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
            {recent && (
              <button className="btn" style={{ height: 38, padding: '0 16px' }} onClick={() => app.openProject(recent.path)}>
                Continue {recent.name} <ArrowRight size={14} />
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
                    <div className="pc-path mono">{p.path.replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Za-z]:\/Users\/[^/]+/i, '~')}</div>
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
            <AgentReadiness />
            <GettingStarted ready={ready} opened={projects.length > 0} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Each listed agent with whether it can take work now: the main ones always, any other once found. */
function useReadiness(): [AgentDef, Readiness][] {
  const agents = useApp((s) => s.agents)
  const [signIns, setSignIns] = useState<Record<string, SignIn>>({})
  useEffect(() => {
    let live = true
    Promise.all(MAIN_AGENTS.map((id) => invoke<SignIn>('profiles:default', id).then((s) => [id, s] as const, () => null))).then((r) => {
      if (live) setSignIns(Object.fromEntries(r.filter((x) => x !== null)))
    })
    return () => {
      live = false
    }
  }, [agents])
  return useMemo(() => {
    const scanned = agents.length > 0
    const listed = AGENTS.filter((a) => a.id !== 'shell' && (MAIN_AGENTS.includes(a.id) || agents.some((x) => x.id === a.id && x.path)))
    return listed.map((a) => [a, readinessOf(a, scanned ? (agents.find((x) => x.id === a.id) ?? { id: a.id, path: null }) : undefined, signIns[a.id])])
  }, [agents, signIns])
}

const STATE_ICON = { ready: Check, signin: CircleAlert, missing: CircleAlert, scanning: RefreshCw } as const

function AgentReadiness() {
  const rows = useReadiness()
  const [busy, setBusy] = useState(false)
  const rescan = async () => {
    setBusy(true)
    await useApp.getState().refreshAgents(true)
    setBusy(false)
  }
  return (
    <>
      <div className="label row">
        Your agents
        <span className="spacer" />
        <button className="icon-btn sm" title="Look again (after installing or signing in)" onClick={rescan} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} />
        </button>
      </div>
      <div className="agent-ready">
        {rows.map(([a, r]) => {
          const Icon = STATE_ICON[r.state]
          return (
            <div key={a.id} className={`ar-row ${r.state}`}>
              <span className="dot" style={{ background: a.color }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ar-name">
                  {a.name}
                  <Icon size={13} className="ar-icon" />
                </div>
                <div className="ar-detail">{r.state === 'scanning' ? 'Looking…' : r.detail}</div>
                {r.state === 'signin' && <Hint text="Sign in once, in a terminal:" command={r.command} />}
                {r.state === 'missing' && MAIN_AGENTS.includes(a.id) && (r.command ? <Hint text="Install it with:" command={r.command} /> : null)}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Hint({ text, command }: { text: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="ar-hint">
      <span>{text}</span>
      <code className="mono">{command}</code>
      <button
        className="icon-btn xs"
        title="Copy"
        onClick={() =>
          navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => undefined
          )
        }
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </div>
  )
}

/** The three things between installing Fleetboard and a team at work, ticked off as they happen. */
function GettingStarted({ ready, opened }: { ready: boolean; opened: boolean }) {
  const steps = [
    { done: ready, title: 'Sign in to an agent.', body: 'Any one of the above. Fleetboard uses the subscriptions you already have.' },
    { done: opened, title: 'Open a repo.', body: 'It becomes a board, with a few goals to start from taken from the repo itself.' },
    { done: false, title: 'Give it a goal.', body: 'Type what you want in the bar. A Lead plans it, workers build it in their own branches, and nothing lands in your checkout until you merge it.' }
  ]
  return (
    <div className="first-run">
      {steps.map((s, i) => (
        <div key={i} className={`fr-step ${s.done ? 'done' : ''}`}>
          <span>{s.done ? <Check size={12} /> : i + 1}</span>
          <div>
            <b>{s.title}</b> {s.body}
          </div>
        </div>
      ))}
    </div>
  )
}
