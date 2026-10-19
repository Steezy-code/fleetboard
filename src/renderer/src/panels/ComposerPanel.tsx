import { useEffect, useState } from 'react'
import { Minus, Plus, Users } from 'lucide-react'
import type { Role } from '@shared/types'
import { ROLES, ROLE_TINT } from '@shared/types'
import { agentById } from '@shared/agents'
import { useApp } from '../state/store'
import { agentColor, agentLabel, spawnConsoles } from '../engine/consoles'
import { Modal, Seg } from '../ui/Modal'
import { useInstalledAgents } from '../orchestration/fleet'

const MAX = 12

/** "Compose group": a named team of up to 12 consoles, one agent per slot. */
export default function ComposerPanel({ count: initialCount, agentId }: { count?: number; agentId?: string }) {
  const settings = useApp((s) => s.settings)
  const installed = useInstalledAgents()
  const fallback = installed.includes(settings.defaultAgent) ? settings.defaultAgent : installed.find((a) => a !== 'shell') ?? 'shell'
  const first = agentId && installed.includes(agentId) ? agentId : fallback
  const [name, setName] = useState('Team')
  const [named, setNamed] = useState(false)
  const [role, setRole] = useState<Role>('General')
  const [count, setCount] = useState(Math.min(MAX, Math.max(1, initialCount ?? 4)))
  const [slots, setSlots] = useState<string[]>(() => Array.from({ length: MAX }, () => first))
  const [prompt, setPrompt] = useState('')
  const [perm, setPerm] = useState<'ask' | 'edits' | 'yolo'>(settings.autoApprove ? 'yolo' : 'ask')
  const [picker, setPicker] = useState<number | null>(null)

  // agents detection may land after the panel opens
  useEffect(() => {
    setSlots((s) => s.map((a) => (installed.includes(a) ? a : fallback)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed.join(',')])

  const chosen = slots.slice(0, count)
  const anyYolo = chosen.some((a) => agentById(a, settings.customAgents)?.yoloArgs)
  const anyEdits = chosen.some((a) => agentById(a, settings.customAgents)?.editsArgs)

  const pickRole = (r: Role) => {
    setRole(r)
    if (!named) setName(r === 'General' ? 'Team' : r)
  }

  const spawn = () => {
    const ids = spawnConsoles({
      agents: chosen,
      group: { name: name.trim() || 'Team', role },
      initialPrompt: prompt.trim() || undefined,
      autoApprove: perm === 'yolo',
      acceptEdits: perm === 'edits'
    })
    const app = useApp.getState()
    app.closePanel()
    if (ids.length) {
      app.toast(`Spawned ${ids.length} in ${name.trim() || 'Team'}`, 'ok')
      window.setTimeout(() => useApp.getState().fitAll(), 60)
    }
  }

  return (
    <Modal
      title="Compose group"
      sub="A team of real agent CLIs side by side. Pick an agent per slot, name the team, give it a starting task."
      icon={<Users size={17} />}
      width={720}
      footer={
        <>
          <div className="row">
            <span className="muted">Agents</span>
            <button className="icon-btn" onClick={() => setCount(Math.max(1, count - 1))} disabled={count <= 1}>
              <Minus size={14} />
            </button>
            <span className="mono" style={{ width: 20, textAlign: 'center' }}>
              {count}
            </span>
            <button className="icon-btn" onClick={() => setCount(Math.min(MAX, count + 1))} disabled={count >= MAX}>
              <Plus size={14} />
            </button>
          </div>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => useApp.getState().closePanel()}>
            Cancel
          </button>
          <button className="btn primary" onClick={spawn}>
            Spawn {count}
          </button>
        </>
      }
    >
      <div className="cmp">
        <div className="cmp-row">
          <div className="grow">
            <div className="label cmp-label">Team name</div>
            <input
              className="input"
              value={name}
              onChange={(e) => (setName(e.target.value), setNamed(true))}
              onKeyDown={(e) => e.key === 'Enter' && spawn()}
            />
          </div>
        </div>
        <div className="label cmp-label">Role</div>
        <div className="cmp-roles">
          {ROLES.map((r) => (
            <button key={r} className={`chip ${role === r ? 'on' : ''}`} onClick={() => pickRole(r)}>
              <span className="dot" style={{ background: role === r ? '#fff' : ROLE_TINT[r] }} />
              {r}
            </button>
          ))}
        </div>

        <div className="row cmp-label" style={{ marginTop: 16 }}>
          <span className="label">Slots</span>
          <span className="spacer" />
          <span className="dim small">Click a slot to choose its agent</span>
        </div>
        <div className="cmp-grid" style={{ ['--tint' as any]: ROLE_TINT[role] }}>
          {chosen.map((a, i) => (
            <div key={i} className="cmp-slot-wrap">
              <button className={`cmp-slot ${picker === i ? 'on' : ''}`} onClick={() => setPicker(picker === i ? null : i)}>
                <span className="cmp-tile" style={{ background: agentColor(a) }}>
                  {agentLabel(a).slice(0, 1)}
                </span>
                <span className="cmp-slot-name">{agentLabel(a)}</span>
                <span className="cmp-slot-n">{i + 1}</span>
              </button>
              {picker === i && (
                <div className="menu cmp-picker" onMouseLeave={() => setPicker(null)}>
                  <div className="menu-label label">Slot {i + 1}</div>
                  {installed.map((id) => (
                    <button
                      key={id}
                      className={`menu-item ${a === id ? 'on' : ''}`}
                      onClick={() => {
                        setSlots(slots.map((x, j) => (j === i ? id : x)))
                        setPicker(null)
                      }}
                    >
                      <span className="agent-dot" style={{ background: agentColor(id) }} />
                      {agentLabel(id)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {count < MAX && (
            <button className="cmp-slot add" onClick={() => setCount(count + 1)} title="Add a slot">
              <Plus size={16} />
            </button>
          )}
        </div>

        <div className="row cmp-fill">
          <span className="label">Fill all</span>
          {installed.map((id) => (
            <button key={id} className={`chip ${chosen.every((a) => a === id) ? 'on' : ''}`} onClick={() => setSlots(slots.map(() => id))}>
              <span className="agent-dot" style={{ background: agentColor(id), width: 8, height: 8 }} />
              {agentLabel(id)}
            </button>
          ))}
        </div>

        <div className="label cmp-label" style={{ marginTop: 16 }}>
          First prompt <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
        </div>
        <textarea
          className="textarea"
          rows={3}
          placeholder="Give the whole team a starting task"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="settings-rows" style={{ marginTop: 14 }}>
          <div className="settings-row">
            <div className="grow">
              <div>Permissions</div>
              <div className="muted small">
                {perm === 'ask'
                  ? 'Agents ask before every edit and command. You approve each one from the board.'
                  : perm === 'edits'
                    ? anyEdits
                      ? 'File edits are accepted automatically; running commands still asks you. A good default for scoped tasks.'
                      : 'None of the chosen agents has an accept-edits mode; they will ask as usual.'
                    : anyYolo
                      ? 'Agents stop asking before edits or commands. Use only on a branch or worktree you can throw away.'
                      : 'None of the chosen agents has an auto-approval flag.'}
              </div>
            </div>
            <Seg<'ask' | 'edits' | 'yolo'>
              value={perm}
              options={[
                { value: 'ask', label: 'Ask' },
                { value: 'edits', label: 'Accept edits' },
                { value: 'yolo', label: 'Auto-approve' }
              ]}
              onChange={setPerm}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}
