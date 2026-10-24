import { RecoverySection } from './RecoverySection'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bot, Palette, Database, FolderOpen, Keyboard, Mic, Move, Minus, Plus, RefreshCw, Route, Settings as SettingsIcon, Smartphone, Tag, TerminalSquare, Trash2 } from 'lucide-react'
import type { AgentDef } from '@shared/types'
import type { UpdateCheck } from '../../../main/update'
import { AGENTS, readsOnly } from '@shared/agents'
import { invoke, on } from '../lib/api'
import { useApp } from '../state/store'
import { Modal, Seg, Switch } from '../ui/Modal'
import { AppearanceSection } from './AppearanceSection'

const VOICES = [
  { id: 'af_heart', label: 'Heart', note: 'US · warm' },
  { id: 'af_bella', label: 'Bella', note: 'US · bright' },
  { id: 'af_nicole', label: 'Nicole', note: 'US · soft' },
  { id: 'am_michael', label: 'Michael', note: 'US · male' },
  { id: 'am_fenrir', label: 'Fenrir', note: 'US · male, deep' },
  { id: 'bf_emma', label: 'Emma', note: 'UK' },
  { id: 'bm_george', label: 'George', note: 'UK · male' }
]
const STT_MODELS = [
  { id: 'onnx-community/whisper-tiny.en', label: 'Whisper tiny', note: 'fastest' },
  { id: 'onnx-community/whisper-base.en', label: 'Whisper base', note: 'balanced' },
  { id: 'onnx-community/whisper-small.en', label: 'Whisper small', note: 'most accurate' }
]
const SECTIONS = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'planner', label: 'Planner', icon: Route },
  { id: 'navigation', label: 'Navigation', icon: Move },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'names', label: 'Names', icon: Tag },
  { id: 'phone', label: 'Phone Inbox', icon: Smartphone },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'keys', label: 'Shortcuts', icon: Keyboard }
]
const SHORTCUTS: [string, string][] = [
  ['Hold Space', 'Push to talk (or Alt+Space, see Voice)'],
  ['@name', 'Direct a command at a console in the command bar'],
  ['1 – 9 (empty bar)', 'Answer the Inbox card in front'],
  ['Tab / Shift+Tab', 'Next / previous Inbox item (in the command bar)'],
  ['Ctrl+I', 'Show all Inbox items'],
  ['V', 'Select tool'],
  ['P', 'Pen'],
  ['R', 'Shapes'],
  ['T', 'Text'],
  ['E', 'Eraser'],
  ['Delete', 'Remove the selection (asks before closing live consoles)'],
  ['Esc', 'Close panel · leave focus · clear selection (inside a terminal, Esc goes to the CLI)'],
  ['Ctrl + A', 'Select everything on the board'],
  ['Ctrl + =  /  Ctrl + −', 'Zoom in / out'],
  ['Scroll', 'Zoom at the cursor (CAD navigation)'],
  ['Middle-drag', 'Pan, from anywhere on the board'],
  ['Double-middle-click  /  Home  /  Z E', 'Zoom extents: fit everything'],
  ['Z P', 'Zoom previous'],
  ['Z W', 'Zoom window: drag the area to zoom into'],
  ['Z O', 'Zoom to the selection'],
  ['Click a tile  /  F  /  Ctrl + Shift + F', 'Focus: dive into it full screen'],
  ['Ctrl + Shift + ←  /  →', 'Focus the previous / next console'],
  ['Ctrl + Shift + F  /  Esc  /  Ctrl + scroll out', 'Leave focus, back to your view'],
  ['Drag left → right', 'Window select: fully enclosed items'],
  ['Drag right → left', 'Crossing select: anything touched'],
  ['Shift + scroll  /  Alt + scroll', 'Pan sideways / up and down'],
  ['Ctrl + 0', 'Fit everything'],
  ['Ctrl + 1', 'Zoom to 100% around the center'],
  ['Ctrl + scroll', 'Zoom, even over a console']
]

const PALETTE: readonly [string, ...string[]] = ['#ff7a45', '#f5b740', '#3ecf8e', '#60a5fa', '#c084fc', '#ec4899', '#2dd4bf', '#a8a29e']

/** Split a command line into bin + args (handles simple quotes). */
function splitCommand(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

export default function SettingsPanel({ section }: { section?: string }) {
  const settings = useApp((s) => s.settings)
  const agents = useApp((s) => s.agents)
  const set = useApp.getState().setSettings
  const bodyRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(section ?? 'agents')
  const [refreshing, setRefreshing] = useState(false)

  const installed = useMemo(() => new Set(agents.filter((a) => a.path).map((a) => a.id)), [agents])
  const allAgents = useMemo(() => [...AGENTS, ...settings.customAgents], [settings.customAgents])
  const installedAgents = allAgents.filter((a) => installed.has(a.id) || a.id === 'shell' || settings.customAgents.some((c) => c.id === a.id))
  // the planner reads console output and PR comments: only a CLI whose headless run can be held to reading
  const headless = allAgents.filter((a) => a.headless && installed.has(a.id) && readsOnly(a.id))

  const go = (id: string) => {
    setActive(id)
    bodyRef.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const onScroll = () => {
    const body = bodyRef.current
    if (!body) return
    const top = body.getBoundingClientRect().top
    let cur = SECTIONS[0]?.id ?? ''
    for (const s of SECTIONS) {
      const el = body.querySelector(`[data-section="${s.id}"]`) as HTMLElement | null
      if (el && el.getBoundingClientRect().top - top < 80) cur = s.id
    }
    setActive(cur)
  }

  const toggleAutoApprove = async (on: boolean) => {
    if (on) {
      const ok = await useApp.getState().confirm({
        title: 'Turn on auto-approve for new consoles?',
        body: "Agents stop asking before editing files or running commands. Each CLI starts with its own bypass flag (e.g. --dangerously-skip-permissions). Only use this in repos you're happy to let them change.",
        confirm: 'Turn on',
        danger: true
      })
      if (!ok) return
    }
    set({ autoApprove: on })
  }

  const rescan = async () => {
    setRefreshing(true)
    await useApp.getState().refreshAgents(true)
    setRefreshing(false)
  }

  return (
    <Modal title="Settings" sub="Saved instantly to ~/.fleetboard/app.json." icon={<SettingsIcon size={17} />} width={780} height={640} bare>
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`settings-nav-item ${active === s.id ? 'on' : ''}`} onClick={() => go(s.id)}>
              <s.icon size={14} /> {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body scrollable" ref={bodyRef} onScroll={onScroll}>
          {/* ---------- Agents ---------- */}
          <section data-section="agents">
            <h3 className="settings-h">Agents</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="grow">
                  <div>Default agent</div>
                  <div className="muted small">Used by New console, Spawn 4 and voice commands that don't name an agent.</div>
                </div>
                <select className="select" style={{ width: 200 }} value={settings.defaultAgent} onChange={(e) => set({ defaultAgent: e.target.value })}>
                  {installedAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  {!installedAgents.some((a) => a.id === settings.defaultAgent) && <option value={settings.defaultAgent}>{settings.defaultAgent} (not installed)</option>}
                </select>
              </div>
              <div className="settings-row" style={settings.autoApprove ? { background: 'color-mix(in srgb, var(--danger) 7%, transparent)' } : undefined}>
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    Auto-approve {settings.autoApprove && <span className="pill" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 50%, transparent)' }}>on</span>}
                  </div>
                  <div className="small" style={{ color: settings.autoApprove ? '#fda4af' : 'var(--muted)', lineHeight: 1.45 }}>
                    <AlertTriangle size={11} style={{ verticalAlign: -1 }} /> Agents stop asking before editing files or running commands. Off by default. Applies to consoles
                    started after the change.
                  </div>
                </div>
                <Switch title="Automatically approve agent actions" on={settings.autoApprove} onChange={toggleAutoApprove} />
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Confirm before closing a running console</div>
                  <div className="muted small">Closing a live console ends its session.</div>
                </div>
                <Switch title="Confirm before closing consoles" on={settings.confirmKill} onChange={(v) => set({ confirmKill: v })} />
              </div>
            </div>
            <CustomAgents />
          </section>

          <AppearanceSection />

          {/* ---------- Voice ---------- */}
          <section data-section="voice">
            <h3 className="settings-h">Voice</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="grow">
                  <div>Speak replies</div>
                  <div className="muted small">Short spoken confirmations, synthesized on this machine (Kokoro).</div>
                </div>
                <Switch title="Speak replies" on={settings.speakReplies} onChange={(v) => set({ speakReplies: v })} />
              </div>
              <div className="settings-row">
                <div className="grow">Voice</div>
                <select className="select" style={{ width: 220 }} value={settings.voiceName} disabled={!settings.speakReplies} onChange={(e) => set({ voiceName: e.target.value })}>
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.note}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Speech model</div>
                  <div className="muted small">Downloaded once from Hugging Face, then runs offline.</div>
                </div>
                <select className="select" style={{ width: 240 }} value={settings.sttModel} onChange={(e) => set({ sttModel: e.target.value })}>
                  {STT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                  {!STT_MODELS.some((m) => m.id === settings.sttModel) && <option value={settings.sttModel}>{settings.sttModel}</option>}
                </select>
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Push-to-talk key</div>
                  <div className="muted small">Hold to speak while focus is on the board.</div>
                </div>
                <Seg<'Space' | 'AltSpace'>
                  value={settings.pushToTalkKey}
                  onChange={(v) => set({ pushToTalkKey: v })}
                  options={[
                    { value: 'Space', label: 'Space' },
                    { value: 'AltSpace', label: 'Alt + Space' }
                  ]}
                />
              </div>
            </div>
          </section>

          {/* ---------- Planner ---------- */}
          <section data-section="planner">
            <h3 className="settings-h">Planner</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="grow">
                  <div>Planner agent</div>
                  <div className="muted small">Runs headless for voice plans, studios, memory scans, handoffs and loop judges — on your own sign-in.</div>
                </div>
                <select className="select" style={{ width: 200 }} value={settings.plannerAgent} onChange={(e) => set({ plannerAgent: e.target.value })}>
                  {headless.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  {!headless.some((a) => a.id === settings.plannerAgent) && <option value={settings.plannerAgent}>{settings.plannerAgent} ({readsOnly(settings.plannerAgent) ? 'not installed' : 'cannot run read-only: Claude Code is used'})</option>}
                </select>
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Oracle</div>
                  <div className="muted small">The command bar reads the whole board first, then answers or suggests the best route: a playbook, a team, or a message to an agent already on it.</div>
                </div>
                <Switch title="Oracle" on={settings.helm !== false} onChange={(v) => set({ helm: v })} />
              </div>
            </div>
          </section>

          {/* ---------- Navigation ---------- */}
          <section data-section="navigation">
            <h3 className="settings-h">Navigation</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="grow">
                  <div>Mouse style</div>
                  <div className="muted small">
                    {settings.navigation === 'trackpad'
                      ? 'Trackpad: scroll pans, Ctrl+scroll or pinch zooms, drag empty space to pan, Shift+drag selects.'
                      : 'CAD (AutoCAD): scroll zooms at the cursor, middle-drag pans, double-middle-click fits everything, left-drag draws window / crossing selections.'}
                  </div>
                </div>
                <Seg<'cad' | 'trackpad'>
                  value={settings.navigation}
                  options={[
                    { value: 'cad', label: 'CAD' },
                    { value: 'trackpad', label: 'Trackpad' }
                  ]}
                  onChange={(v) => set({ navigation: v })}
                />
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Minimap</div>
                  <div className="muted small">Overview of the board in the corner; click or drag it to move the view.</div>
                </div>
                <Switch title="Show minimap" on={settings.showMinimap} onChange={(v) => set({ showMinimap: v })} />
              </div>
            </div>
          </section>

          {/* ---------- Terminal ---------- */}
          <section data-section="terminal">
            <h3 className="settings-h">Terminal</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <div className="grow">
                  <div>Font size</div>
                  <div className="muted small mono" style={{ fontSize: settings.fontSize }}>
                    claude › ready
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="icon-btn" disabled={settings.fontSize <= 10} onClick={() => set({ fontSize: Math.max(10, settings.fontSize - 1) })}>
                    <Minus size={14} />
                  </button>
                  <span className="mono" style={{ width: 34, textAlign: 'center' }}>
                    {settings.fontSize}px
                  </span>
                  <button className="icon-btn" disabled={settings.fontSize >= 18} onClick={() => set({ fontSize: Math.min(18, settings.fontSize + 1) })}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- Names ---------- */}
          <section data-section="names">
            <h3 className="settings-h">Names</h3>
            <NamesEditor />
          </section>

          {/* ---------- Phone Inbox ---------- */}
          <section data-section="phone">
            <h3 className="settings-h">Phone Inbox</h3>
            <PhoneInbox />
          </section>

          {/* ---------- Data ---------- */}
          <section data-section="data">
            <h3 className="settings-h">Data</h3>
            <RecoverySection />
            <div className="settings-rows">
              <VersionRow />
              <div className="settings-row">
                <div className="grow">
                  <div>Fleetboard folder</div>
                  <div className="muted small">
                    Boards, history snapshots, profiles and settings live in <span className="mono">~/.fleetboard</span>.
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const p = await invoke<{ root: string }>('app:paths')
                    invoke('shell:openPath', p.root)
                  }}
                >
                  <FolderOpen size={12} /> Open
                </button>
              </div>
              <div className="settings-row">
                <div className="grow">
                  <div>Agents on PATH</div>
                  <div className="muted small">
                    {installed.size} of {AGENTS.length} found. Rescan after installing or signing in to a CLI.
                  </div>
                </div>
                <button className="btn sm" onClick={rescan}>
                  <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Rescan
                </button>
              </div>
            </div>
          </section>

          {/* ---------- Shortcuts ---------- */}
          <section data-section="keys">
            <h3 className="settings-h">Keyboard shortcuts</h3>
            <div className="settings-rows">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="settings-row" style={{ padding: '8px 14px' }}>
                  <span className="grow muted">{v}</span>
                  <span className="row" style={{ gap: 4 }}>
                    {k.split('  /  ').map((part, i) => (
                      <span key={i} className="kbd">
                        {part}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </Modal>
  )
}

function CustomAgents() {
  const custom = useApp((s) => s.settings.customAgents)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const set = useApp.getState().setSettings

  const add = () => {
    const parts = splitCommand(command.trim())
    if (!name.trim() || !parts.length) return
    const base = 'custom-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    let id = base
    for (let i = 2; [...AGENTS, ...custom].some((a) => a.id === id); i++) id = `${base}-${i}`
    const def: AgentDef = { id, name: name.trim(), bin: parts[0] ?? '', args: parts.slice(1), color: PALETTE[custom.length % PALETTE.length] ?? PALETTE[0], vendor: 'Custom' }
    set({ customAgents: [...custom, def] })
    setName('')
    setCommand('')
  }
  const remove = async (a: AgentDef) => {
    const ok = await useApp.getState().confirm({ title: `Remove ${a.name}?`, body: 'Consoles already on the board keep their settings but will not start again.', confirm: 'Remove', danger: true })
    if (ok) set({ customAgents: custom.filter((c) => c.id !== a.id) })
  }

  return (
    <>
      <div className="label" style={{ margin: '16px 0 8px' }}>
        Custom agents
      </div>
      <div className="settings-rows">
        {custom.map((a) => (
          <div key={a.id} className="settings-row">
            <span className="agent-badge" style={{ background: a.color, width: 22, height: 22, fontSize: 11 }}>
              {a.name[0]}
            </span>
            <div className="grow">
              <div>{a.name}</div>
              <div className="muted small mono">{[a.bin, ...(a.args ?? [])].join(' ')}</div>
            </div>
            <button className="icon-btn sm" title="Remove" onClick={() => remove(a)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="settings-row">
          <input className="input" style={{ width: 150 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input mono grow" placeholder="Command, e.g. my-agent --model fast" value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn sm" disabled={!name.trim() || !command.trim()} onClick={add}>
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
    </>
  )
}

function NamesEditor() {
  const names = useApp((s) => s.settings.names)
  const [text, setText] = useState(names.join(', '))
  const commit = () => {
    const list = [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))]
    if (list.length) useApp.getState().setSettings({ names: list })
    setText((list.length ? list : names).join(', '))
  }
  return (
    <div className="settings-rows">
      <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div className="muted small">New consoles take the next free name; once all are used they continue as "Maya 2", "Rafa 2", …</div>
        <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
        <div className="row">
          <span className="dim small grow">{names.length} names · comma-separated</span>
          <button className="btn ghost sm" onClick={commit}>
            Save names
          </button>
        </div>
      </div>
    </div>
  )
}

type RemoteNetwork = 'tailscale' | 'lan' | 'local'
interface RemoteStatus {
  enabled: boolean
  network: RemoteNetwork
  running: boolean
  url?: string
  qr?: string
  error?: string
  addresses: { tailscale?: string; lan?: string }
}

/** Answer approvals, questions and Ready cards from a phone, over Tailscale or the local network. */
function PhoneInbox() {
  const [st, setSt] = useState<RemoteStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const load = () => invoke<RemoteStatus>('remote:status').then(setSt, () => {})
    load()
    // it moved to a new address, or lost or found its network
    return on('remote:changed', load)
  }, [])
  if (!st) return null
  const run = async (channel: string, ...args: unknown[]) => {
    setBusy(true)
    try {
      setSt(await invoke<RemoteStatus>(channel, ...args))
    } finally {
      setBusy(false)
    }
  }
  const enable = async (on: boolean, network = st.network) => {
    if (on && network === 'lan') {
      const ok = await useApp.getState().confirm({
        title: 'Serve the Inbox on your local network?',
        body: 'It is plain HTTP: someone on the same network who can see its traffic could copy the link and answer for you. Tailscale encrypts the connection; prefer it when you can.',
        confirm: 'Use the local network',
        danger: true
      })
      if (!ok) return
    }
    await run(on ? 'remote:enable' : 'remote:disable', network)
  }
  const choose = (network: RemoteNetwork) => (st.enabled ? enable(true, network) : setSt({ ...st, network }))
  const copy = () => {
    if (!st.url) return
    navigator.clipboard.writeText(st.url)
    useApp.getState().toast('Link copied. Anyone with it can answer for you: send it only to yourself.', 'info')
  }
  const reset = async () => {
    const ok = await useApp.getState().confirm({ title: 'Make a new link?', body: 'The current link stops working right away.', confirm: 'New link' })
    if (ok) await run('remote:reset')
  }
  return (
    <div className="settings-rows">
      <div className="settings-row">
        <div className="grow">
          <div>Answer from your phone</div>
          <div className="muted small">Approvals, the Lead's questions and Ready cards on your phone, so agents don't wait while you're away. Off until you turn it on.</div>
        </div>
        <Switch title="Phone Inbox" on={st.enabled} onChange={(v) => !busy && enable(v)} />
      </div>
      <div className="settings-row">
        <div className="grow">
          <div>Network</div>
          <div className="muted small">
            {st.network === 'tailscale'
              ? st.addresses.tailscale
                ? `Tailscale (${st.addresses.tailscale}): encrypted, reachable from your devices anywhere.`
                : 'Tailscale is not running on this computer.'
              : st.network === 'lan'
                ? `Local network (${st.addresses.lan ?? 'no address'}): plain HTTP, same Wi-Fi only.`
                : 'This computer only (127.0.0.1): to try it in a browser here.'}
          </div>
        </div>
        <Seg
          value={st.network}
          onChange={(v) => choose(v as RemoteNetwork)}
          options={[
            { value: 'tailscale', label: 'Tailscale' },
            { value: 'lan', label: 'Wi-Fi' },
            { value: 'local', label: 'This PC' }
          ]}
        />
      </div>
      {st.error && (
        <div className="settings-row">
          <div className="small" style={{ color: 'var(--warn)' }}>
            <AlertTriangle size={11} style={{ verticalAlign: -1 }} /> {st.error}
          </div>
        </div>
      )}
      {st.running && st.url && (
        <div className="settings-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          {/* our own QR (numbers only), not content from elsewhere */}
          <div className="phone-qr" dangerouslySetInnerHTML={{ __html: st.qr ?? '' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div>Scan with your phone's camera</div>
            <div className="muted small" style={{ margin: '4px 0 10px' }}>
              Anyone with this link can answer your agents' questions. It works until you make a new one.
            </div>
            <div className="mono small" style={{ wordBreak: 'break-all', userSelect: 'text' }}>
              {st.url}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn sm" onClick={copy}>
                Copy link
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={reset}>
                <RefreshCw size={12} /> New link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Which Fleetboard this is, and whether a newer one has been released. Nothing downloads or installs:
 * the installer is unsigned and the repo is private, so the release page in the user's own signed-in
 * browser is where this honestly ends.
 */
function VersionRow() {
  const [out, setOut] = useState<UpdateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const check = (force = false) => {
    setBusy(force)
    invoke<UpdateCheck>('update:check', force).then(
      (r) => {
        setOut(r)
        setBusy(false)
      },
      () => setBusy(false)
    )
  }
  useEffect(() => check(), [])
  const newer = out?.newer
  return (
    <div className="settings-row">
      <div className="grow">
        <div>Fleetboard {out?.current ?? ''}</div>
        <div className="muted small">
          {busy
            ? 'Asking GitHub…'
            : newer
              ? `${newer.tag} is out.`
              : out?.error
                ? out.error
                : out?.latest
                  ? `Up to date — ${out.latest.tag} is the latest release.`
                  : out
                    ? 'No releases yet.'
                    : 'Checking for a newer release…'}
        </div>
      </div>
      {newer?.url && (
        <button className="btn sm primary" onClick={() => void invoke('shell:openExternal', newer.url)}>
          Open release
        </button>
      )}
      <button className="btn sm" disabled={busy} onClick={() => check(true)}>
        <RefreshCw size={12} className={busy ? 'spin' : ''} /> Check
      </button>
    </div>
  )
}
