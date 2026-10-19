import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, Download, Minus, Plus, RefreshCw } from 'lucide-react'
import type { Profile } from '@shared/types'
import { AGENTS } from '@shared/agents'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { spawnConsoles } from '../engine/consoles'
import { Modal, Switch } from '../ui/Modal'

/** "New console": pick an agent CLI (installed ones first), how many, profile and auto-approval. */
export default function SpawnPanel({ agentId: initial, count: initialCount }: { agentId?: string; count?: number }) {
  const agents = useApp((s) => s.agents)
  const settings = useApp((s) => s.settings)
  const [agentId, setAgentId] = useState(initial ?? settings.defaultAgent)
  const [count, setCount] = useState(initialCount ?? 1)
  const [yolo, setYolo] = useState(settings.autoApprove)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState<string>('')
  const [showAll, setShowAll] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    invoke<Profile[]>('profiles:list').then(setProfiles)
  }, [])

  const installed = useMemo(() => new Map(agents.filter((a) => a.path).map((a) => [a.id, a])), [agents])
  const list = useMemo(() => {
    const all = [...AGENTS, ...settings.customAgents]
    const sorted = all.sort((a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)))
    return showAll ? sorted : sorted.filter((a) => installed.has(a.id))
  }, [installed, showAll, settings.customAgents])
  const agentProfiles = profiles.filter((p) => p.agentId === agentId)
  const selected = list.find((a) => a.id === agentId)

  const spawn = () => {
    const ids = spawnConsoles({ agentId, count, autoApprove: yolo, profileId: profileId || undefined })
    useApp.getState().closePanel()
    if (ids.length) setTimeout(() => (count === 1 ? useApp.getState().focusItem(ids[0]) : useApp.getState().fitAll()), 60)
  }

  return (
    <Modal
      title="New console"
      sub="Each console is the agent's real CLI in a real terminal, on the plan you're already signed into."
      icon={<Bot size={17} />}
      width={620}
      headerRight={
        <button
          className="icon-btn"
          title="Rescan PATH"
          onClick={async () => {
            setRefreshing(true)
            await useApp.getState().refreshAgents(true)
            setRefreshing(false)
          }}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
        </button>
      }
      footer={
        <>
          <div className="row">
            <span className="muted">Count</span>
            <button className="icon-btn" onClick={() => setCount(Math.max(1, count - 1))}>
              <Minus size={14} />
            </button>
            <span className="mono" style={{ width: 18, textAlign: 'center' }}>
              {count}
            </span>
            <button className="icon-btn" onClick={() => setCount(Math.min(12, count + 1))}>
              <Plus size={14} />
            </button>
          </div>
          <span className="spacer" />
          <button className="btn primary" disabled={!installed.has(agentId) && agentId !== 'shell'} onClick={spawn}>
            Spawn {count > 1 ? count : ''} {selected?.name ?? ''}
          </button>
        </>
      }
    >
      <div className="label" style={{ margin: '4px 0 8px' }}>
        Agent
      </div>
      <div className="agent-grid">
        {list.map((a) => {
          const have = installed.get(a.id)
          return (
            <button
              key={a.id}
              className={`agent-card ${agentId === a.id ? 'on' : ''} ${have ? '' : 'missing'}`}
              onClick={() => setAgentId(a.id)}
              onDoubleClick={() => have && (setAgentId(a.id), setTimeout(spawn))}
            >
              <span className="agent-badge" style={{ background: a.color }}>
                {a.name.slice(0, 1)}
              </span>
              <span className="grow" style={{ textAlign: 'left', minWidth: 0 }}>
                <span className="agent-name">{a.name}</span>
                <span className="agent-meta">{have ? have.version ?? a.vendor : 'not installed'}</span>
              </span>
              {agentId === a.id && <Check size={14} color="var(--accent)" />}
            </button>
          )
        })}
      </div>
      <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
        {showAll ? 'Only installed agents' : `All ${AGENTS.length} agents`}
      </button>
      {selected && !installed.has(selected.id) && selected.install && (
        <div className="hint-box">
          <Download size={14} />
          <span>
            Install with <code className="mono">{selected.install}</code>, sign in once in a console, then rescan.
          </span>
        </div>
      )}

      <div className="settings-rows" style={{ marginTop: 16 }}>
        {agentProfiles.length > 0 && (
          <div className="settings-row">
            <div className="grow">
              <div>Account profile</div>
              <div className="muted small">Each profile has its own sign-in and sessions.</div>
            </div>
            <select className="select" style={{ width: 200 }} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Default sign-in</option>
              {agentProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {selected?.yoloArgs && (
          <div className="settings-row">
            <div className="grow">
              <div>Auto-approve</div>
              <div className="muted small">
                Starts with <code className="mono">{selected.yoloArgs.join(' ')}</code>. The agent stops asking before it edits or runs things.
              </div>
            </div>
            <Switch on={yolo} onChange={setYolo} />
          </div>
        )}
      </div>
    </Modal>
  )
}
