import { useCallback, useEffect, useState } from 'react'
import { Briefcase, Check, FolderOpen, Info, Pencil, Plus, Trash2 } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { spawnConsoles } from '../engine/consoles'
import { Drawer } from '../ui/Modal'
import { initials } from '../continuity/format'
import type { DefaultSignIn, ProfileInfo } from '../continuity/types'

const PROFILE_AGENTS = AGENTS.filter((a) => a.configEnv)
const shortName = (id: string) => (id === 'claude' ? 'Claude' : AGENTS.find((a) => a.id === id)?.name ?? id)

/** Accounts drawer: the default sign-in plus isolated per-CLI profiles (own config dir each). */
export default function AccountsPanel({ agentId: initial }: { agentId?: string }) {
  const [agentId, setAgentId] = useState(initial && PROFILE_AGENTS.some((a) => a.id === initial) ? initial : 'claude')
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [current, setCurrent] = useState<DefaultSignIn | null>(null)
  const [connectName, setConnectName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const agent = PROFILE_AGENTS.find((a) => a.id === agentId)!
  const app = useApp.getState()

  const load = useCallback(async () => {
    const [list, def] = await Promise.all([invoke<ProfileInfo[]>('profiles:list', agentId), invoke<DefaultSignIn>('profiles:default', agentId)])
    setProfiles(list)
    setCurrent(def)
  }, [agentId])
  useEffect(() => {
    load()
    // sign-in state changes while a console logs in; refresh when the window regains focus
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    const t = window.setInterval(load, 8000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(t)
    }
  }, [load])

  const use = (profileId?: string) => {
    const ids = spawnConsoles({ agentId, profileId })
    if (ids[0]) setTimeout(() => useApp.getState().focusItem(ids[0]), 60)
  }

  const saveCurrent = async () => {
    setBusy(true)
    try {
      const { profile, copied } = await invoke<{ profile: ProfileInfo; copied: string[] }>('profiles:saveCurrent', agentId, '')
      app.toast(copied.length ? `Saved "${profile.name}" (${copied.join(', ')})` : `Created "${profile.name}", but no sign-in files were found to copy`, copied.length ? 'ok' : 'warn')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    const name = connectName.trim() || `${shortName(agentId)} account ${profiles.length + 1}`
    const p = await invoke<ProfileInfo>('profiles:create', agentId, name)
    setConnectName('')
    await load()
    const ids = spawnConsoles({ agentId, profileId: p.id, names: [name] })
    if (ids[0]) setTimeout(() => useApp.getState().focusItem(ids[0]), 60)
    app.toast(`Sign in to "${name}" in the new console${agentId === 'claude' ? ' (/login)' : ''}.`, 'info')
  }

  const remove = async (p: ProfileInfo) => {
    const ok = await app.confirm({
      title: `Delete "${p.name}"?`,
      body: `Removes the profile and its folder (${p.dir}), including its sign-in and session history. Consoles already running keep going.`,
      confirm: 'Delete profile',
      danger: true
    })
    if (!ok) return
    await invoke('profiles:delete', p.id)
    load()
  }

  return (
    <Drawer
      title="accounts"
      icon={<Briefcase size={14} color="var(--accent)" />}
      headerRight={
        <div className="row" style={{ gap: 2 }}>
          {PROFILE_AGENTS.map((a) => (
            <button key={a.id} className={`acct-filter ${agentId === a.id ? 'on' : ''}`} title={a.name} onClick={() => setAgentId(a.id)}>
              <span className="acct-filter-dot" style={{ background: a.color }}>
                {a.name[0]}
              </span>
            </button>
          ))}
        </div>
      }
    >
      <div className="acct-note">
        <Info size={13} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          On this machine, some CLIs keep sign-in in the system keyring, which profiles can't fully isolate. After switching, verify the account
          with <code className="mono">/status</code> inside the console.
        </span>
      </div>

      <div className="label acct-section">Your sign-in</div>
      <div className="acct-row current">
        <span className="acct-avatar" style={{ background: agent.color }}>
          {current?.account ? initials(current.account.split('@')[0].replace(/[._-]/g, ' ')) : agent.name[0]}
        </span>
        <div className="grow">
          <div className="acct-name">{current?.account?.split(' · ')[0] ?? 'Default sign-in'}</div>
          <div className="muted small">Powering new {shortName(agentId)} consoles</div>
        </div>
        {current?.signedIn ? (
          <span className="acct-active">
            <span className="dot" style={{ background: 'var(--ok)' }} /> Active
          </span>
        ) : (
          <span className="pill">Signed out</span>
        )}
      </div>

      {profiles.length > 0 && <div className="label acct-section">Profiles</div>}
      {profiles.map((p) => (
        <div key={p.id} className="acct-row">
          <span className="acct-avatar" style={{ background: 'var(--panel-3)', color: 'var(--text)' }}>
            {initials(p.name)}
          </span>
          <div className="grow">
            {renaming === p.id ? (
              <input
                className="input acct-rename"
                autoFocus
                defaultValue={p.name}
                onBlur={async (e) => {
                  await invoke('profiles:rename', p.id, e.target.value)
                  setRenaming(null)
                  load()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <div className="acct-name">{p.name}</div>
            )}
            <div className="muted small acct-sub" title={p.account ?? p.dir}>
              {p.signedIn ? 'Ready when you need it' : 'Not signed in yet'}
            </div>
          </div>
          <button className="btn primary sm" onClick={() => use(p.id)}>
            Use
          </button>
          <button className="icon-btn sm" title="Open folder" onClick={() => invoke('profiles:open', p.id)}>
            <FolderOpen size={13} />
          </button>
          <button className="icon-btn sm" title="Rename" onClick={() => setRenaming(p.id)}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn sm" title="Delete" onClick={() => remove(p)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      <button className="acct-save" disabled={busy || !current?.signedIn} onClick={saveCurrent}>
        <span className="grow">
          Save your current sign-in as a profile
          {!current?.signedIn && <span className="dim small"> · sign in first</span>}
        </span>
        <span className="acct-plus">{busy ? <Check size={13} /> : <Plus size={13} />}</span>
      </button>

      <div className="label acct-section">Connect another account</div>
      <div className="row">
        <input
          className="input"
          placeholder={agentId === 'claude' ? 'e.g. Personal Max' : 'e.g. Work Pro'}
          value={connectName}
          onChange={(e) => setConnectName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect()}
        />
        <button className="btn" onClick={connect}>
          <Plus size={13} /> Connect
        </button>
      </div>
      <div className="dim small" style={{ marginTop: 8, lineHeight: 1.5 }}>
        Creates an empty profile and opens a {shortName(agentId)} console in it, so you sign in there. Its sign-in and sessions stay in{' '}
        <span className="mono">~/.fleetboard/profiles</span> via <span className="mono">{agent.configEnv}</span>.
      </div>
    </Drawer>
  )
}
