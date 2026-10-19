import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Copy, Pause, Play, RotateCcw } from 'lucide-react'
import type { BoardNode, ConsoleData } from '@shared/types'
import { agentById } from '@shared/agents'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { agentColor, agentLabel, killConsoles, onConsoleData, spawnConsoles, startConsole } from '../engine/consoles'
import type { NodeProps } from './types'
import { useFleet } from '../engine/fleet'

const THEME = {
  background: '#0c0b0a',
  foreground: '#e9e2da',
  cursor: '#ff4a2b',
  cursorAccent: '#0c0b0a',
  selectionBackground: 'rgba(255,74,43,0.30)',
  black: '#1c1917',
  red: '#ff5f4a',
  green: '#4ade80',
  yellow: '#f5c06b',
  blue: '#7aa2ff',
  magenta: '#d68cff',
  cyan: '#5fd7d7',
  white: '#d6cfc7',
  brightBlack: '#5f5750',
  brightRed: '#ff7a63',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#a5c0ff',
  brightMagenta: '#e9b5ff',
  brightCyan: '#99f6e4',
  brightWhite: '#fafaf9'
}

export const STATUS_LABEL: Record<string, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'ready',
  'needs-you': 'needs you',
  done: 'done',
  paused: 'paused',
  exited: 'exited'
}

export default function ConsoleNode({ node }: NodeProps<ConsoleData>) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const live = useApp((s) => !!s.live[node.id])
  const status = useApp((s) => s.statuses[node.id])
  const fontSize = useApp((s) => s.settings.fontSize)
  const [phase, setPhase] = useState<'boot' | 'ask' | 'running' | 'exited'>('boot')
  const agent = agentById(node.data.agentId, useApp.getState().settings.customAgents)

  // Create the terminal once and attach to (or start) the PTY.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace",
      fontSize,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => invoke('shell:openExternal', uri)))
    term.open(host.current!)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      /* not laid out yet */
    }

    // Let the CLI see Shift+Enter as a newline the way it does in common terminals.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
        window.fb.send('pty:write', node.id, '\x1b\r')
        return false
      }
      return true
    })
    const offInput = term.onData((d) => window.fb.send('pty:write', node.id, d))
    const offResize = term.onResize(({ cols, rows }) => window.fb.send('pty:resize', node.id, cols, rows))
    const offData = onConsoleData(node.id, (d) => term.write(d))

    let cancelled = false
    ;(async () => {
      const buffer = await invoke<string | null>('pty:buffer', node.id)
      if (cancelled) return
      if (buffer !== null) {
        term.write(buffer)
        setPhase('running')
        useApp.getState().setLive(node.id, true)
        // started elsewhere (a team console the fleet launched): a reopened board asks before resuming it too
        if (node.data.launch !== 'ask') useApp.getState().updateNodeData(node.id, { launch: 'ask' })
        return
      }
      const canResume = !!agent?.resumeArgs
      if (node.data.launch === 'resume') launch(true)
      else if (node.data.launch === 'ask' && canResume) setPhase('ask')
      else launch(false)
    })()

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* hidden */
      }
    })
    ro.observe(host.current!)
    return () => {
      cancelled = true
      ro.disconnect()
      offInput.dispose()
      offResize.dispose()
      offData()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  useEffect(() => {
    if (termRef.current && termRef.current.options.fontSize !== fontSize) {
      termRef.current.options.fontSize = fontSize
      fitRef.current?.fit()
    }
  }, [fontSize])

  // The top bar's "Resume all conversations?" answers for every waiting console.
  useEffect(() => {
    if (phase !== 'ask') return
    if (node.data.launch === 'resume') launch(true)
    else if (node.data.launch === 'fresh') launch(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.data.launch, phase])

  useEffect(() => {
    if (status === 'exited' && phase === 'running') setPhase('exited')
  }, [status, phase])

  // Deliver a queued first prompt (spawn with a prompt, a handoff's brief). The main process waits until
  // the CLI can take input and makes sure Enter took: typed at the first "idle", Claude Code could drop it.
  useEffect(() => {
    const pending = (node.data as any).pendingPrompt as string | undefined
    if (!pending || !live) return
    useApp.getState().updateNodeData(node.id, { pendingPrompt: undefined })
    invoke<boolean>('pty:deliver', node.id, pending.trim()).then(
      (ok) => !ok && useApp.getState().toast(`${node.data.name} did not start in time; its first message was not sent`, 'warn'),
      () => {}
    )
  }, [live, node.id, node.data])

  async function launch(resume: boolean) {
    const term = termRef.current!
    setPhase('running')
    if (resume) term.write('\x1b[38;2;255;106;69m⟳ Restoring console, picking up the last conversation…\x1b[0m\r\n')
    try {
      await startConsole(node, term.cols, term.rows, resume)
      // From now on a reopened board asks before resuming.
      useApp.getState().updateNodeData(node.id, { launch: 'ask' })
    } catch (e) {
      term.write(`\r\n\x1b[31mCould not start ${agentLabel(node.data.agentId)}: ${String(e)}\x1b[0m\r\n`)
      setPhase('exited')
    }
  }

  return (
    <div className="console-body no-board-wheel" onMouseDown={() => termRef.current?.focus()}>
      <div ref={host} className="console-term" data-terminal />
      {phase === 'ask' && (
        <div className="console-overlay">
          <div className="console-ask">
            <div className="row" style={{ gap: 10 }}>
              <RotateCcw size={16} color="var(--accent)" />
              <div>
                <div style={{ fontWeight: 600 }}>Resume last conversation?</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {agentLabel(node.data.agentId)} can pick up where it left off.
                </div>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn sm" onClick={() => launch(false)}>
                New session
              </button>
              <button className="btn sm primary" onClick={() => launch(true)}>
                Resume
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === 'exited' && (
        <div className="console-exited">
          <span className="muted">Process exited.</span>
          <button className="btn sm" onClick={() => launch(false)}>
            Restart
          </button>
          {agent?.resumeArgs && (
            <button className="btn sm" onClick={() => launch(true)}>
              Resume
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ConsoleHeader({ node }: NodeProps<ConsoleData>) {
  const status = useApp((s) => s.statuses[node.id]) ?? (useApp.getState().live[node.id] ? 'idle' : 'exited')
  const [editing, setEditing] = useState(false)
  const yolo = node.data.autoApprove ?? useApp.getState().settings.autoApprove
  return (
    <div className={`row grow st-${status}`} style={{ gap: 7, minWidth: 0 }}>
      <span className="agent-dot" style={{ background: agentColor(node.data.agentId) }} />
      {editing ? (
        <input
          className="title-input"
          autoFocus
          defaultValue={node.data.name}
          onBlur={(e) => {
            useApp.getState().updateNodeData(node.id, { name: e.target.value.trim() || node.data.name })
            setEditing(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="node-title" onDoubleClick={() => setEditing(true)}>
          {node.data.name}
        </span>
      )}
      <span className="node-sub">{agentLabel(node.data.agentId)}</span>
      <FleetBadge id={node.id} />
      {yolo && agentById(node.data.agentId)?.yoloArgs && <span className="pill yolo">yolo</span>}
      {!yolo && node.data.acceptEdits && agentById(node.data.agentId)?.editsArgs && <span className="pill">edits</span>}
      <span className="spacer" />
      <span className="status-pill">
        <span className="status-dot" />
        {STATUS_LABEL[status] ?? status}
      </span>
    </div>
  )
}

export function ConsoleActions({ node }: NodeProps<ConsoleData>) {
  const status = useApp((s) => s.statuses[node.id])
  const live = useApp((s) => !!s.live[node.id])
  return (
    <>
      {live && (
        <button
          className="icon-btn sm"
          title={status === 'paused' ? 'Resume' : 'Pause'}
          onClick={() => invoke(status === 'paused' ? 'pty:resume' : 'pty:pause', node.id)}
        >
          {status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
        </button>
      )}
      <button
        className="icon-btn sm"
        title="Duplicate"
        onClick={() =>
          spawnConsoles({ agentId: node.data.agentId, profileId: node.data.profileId, group: node.groupId, at: { x: node.x + node.w + 24, y: node.y } })
        }
      >
        <Copy size={13} />
      </button>
    </>
  )
}

export async function beforeRemoveConsoles(nodes: BoardNode[]) {
  return killConsoles(
    nodes.map((n) => n.id),
    { remove: false }
  )
}

/** LEAD / WORKER / REVIEWER badge with the member's task as a tooltip. */
function FleetBadge({ id }: { id: string }) {
  const m = useFleet((s) => s.state?.members[id])
  if (!m || m.status === 'closed') return null
  return (
    <span className={`pill fleet-${m.role}`} title={m.task}>
      {m.role}
    </span>
  )
}
