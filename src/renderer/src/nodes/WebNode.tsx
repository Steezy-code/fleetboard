import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { ArrowLeft, ArrowRight, Bug, Check, ChevronDown, Globe, LayoutGrid, Monitor, RotateCw, Smartphone, X } from 'lucide-react'
import type { NodeProps } from './types'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { useDismiss } from './content/util'

// Live web tile: an Electron <webview> with its own address bar, device presets (rendered at the
// device's CSS size and scaled to fit the tile) and a detached inspector.
// node.data = { url: string, device?: string }

interface Device {
  id: string
  label: string
  w: number
  h: number
  phone?: boolean
}
export const DISPLAYS: Device[] = [
  { id: 'mon24', label: '24" monitor', w: 1920, h: 1080 },
  { id: 'mon27', label: '27" monitor', w: 2560, h: 1440 },
  { id: 'mon32', label: '32" 4K', w: 3840, h: 2160 }
]
export const PHONES: Device[] = [
  { id: 'iphonese', label: 'iPhone SE', w: 375, h: 667, phone: true },
  { id: 'iphone14pro', label: 'iPhone 14 Pro', w: 393, h: 852, phone: true },
  { id: 'iphone14promax', label: 'iPhone 14 Pro Max', w: 430, h: 932, phone: true },
  { id: 'pixel7', label: 'Pixel 7', w: 412, h: 915, phone: true },
  { id: 'galaxys8', label: 'Galaxy S8+', w: 360, h: 740, phone: true }
]
const DEVICES = [...DISPLAYS, ...PHONES]
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const PORTS = [
  { port: 3000, hint: 'Next · React · Rails' },
  { port: 5173, hint: 'Vite' },
  { port: 8080, hint: 'Webpack · HTTP' },
  { port: 4321, hint: 'Astro' },
  { port: 8000, hint: 'Django · Python' }
]
const LINKS = [
  { name: 'Google', url: 'https://www.google.com', color: '#4285f4' },
  { name: 'YouTube', url: 'https://www.youtube.com', color: '#ff0033' },
  { name: 'GitHub', url: 'https://github.com', color: '#8b949e' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com', color: '#ff6600' },
  { name: 'MDN', url: 'https://developer.mozilla.org', color: '#5b9cf5' },
  { name: 'npm', url: 'https://www.npmjs.com', color: '#cb3837' }
]

/** `3000`, `:3000`, `localhost:3000`, `example.com`, `http://…` or a search. */
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^\d{2,5}$/.test(s)) return `http://localhost:${s}`
  if (/^:\d{2,5}(\/.*)?$/.test(s)) return `http://localhost${s}`
  // An explicit list, not "any scheme://". The old test passed anything shaped like a scheme, so a
  // tile URL of vscode://, slack:// or similar went to the webview as written — and an
  // external-protocol navigation is handed to the operating system's handler for it. The URL is also
  // persisted in the board file and re-mounted as src on every load, so it is not only what someone
  // types. chrome: is gone with it: Chromium's own pages have no business in a dev-server tile.
  // Anything else falls through to the search below, which is what already happened to input that
  // did not look like a URL.
  if (/^(https?|file|about|data|blob):/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(s)) return `http://${s}`
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

const prettyUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '')

export default function WebNode({ node, selected, maximized }: NodeProps) {
  const url: string = node.data.url ?? ''
  const deviceId: string = node.data.device ?? 'fit'
  const device = DEVICES.find((d) => d.id === deviceId)
  const active = selected || maximized
  const set = (p: Record<string, any>) => useApp.getState().updateNodeData(node.id, p)

  const wvRef = useRef<WebviewTag | null>(null)
  const mountSrc = useRef('')
  // Through the same allowlist the address bar uses. normalizeUrl's own comment says the stored URL is
  // "re-mounted as src on every load, so it is not only what someone types" — but only go() was
  // calling it, and this is the path a board file takes. A board file is written by agents.
  if (url && !mountSrc.current) mountSrc.current = normalizeUrl(url)
  if (!url) mountSrc.current = ''
  const hasView = !!url

  const [addr, setAddr] = useState(url)
  const [editingAddr, setEditingAddr] = useState(false)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [nav, setNav] = useState({ back: false, fwd: false })
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const defaultUA = useRef<string | null>(null)

  useEffect(() => {
    if (!editingAddr) setAddr(url)
  }, [url, editingAddr])

  // webview events
  useEffect(() => {
    const wv = wvRef.current
    if (!hasView || !wv) return
    setReady(false)
    const updNav = () => {
      try {
        setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
      } catch {
        /* not attached yet */
      }
    }
    const onStart = () => {
      setLoading(true)
      setError(null)
    }
    const onStop = () => {
      setLoading(false)
      updNav()
    }
    const onNav = (e: any) => {
      if (e.isMainFrame === false) return
      if (e.url && e.url !== 'about:blank') set({ url: e.url })
      updNav()
    }
    const onTitle = (e: any) => e.title && useApp.getState().updateNode(node.id, { title: e.title })
    const onReady = () => {
      setReady(true)
      updNav()
      if (defaultUA.current === null) {
        try {
          defaultUA.current = wv.getUserAgent()
        } catch {
          defaultUA.current = ''
        }
      }
    }
    const onFail = (e: any) => {
      if (!e.isMainFrame || e.errorCode === -3) return
      setLoading(false)
      setError(`${e.errorDescription || 'Failed to load'} · ${prettyUrl(e.validatedURL || '')}`)
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-fail-load', onFail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasView, node.id])

  // phones get a mobile user agent
  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !ready || defaultUA.current === null) return
    const want = device?.phone ? (/pixel|galaxy/i.test(device.label) ? UA_ANDROID : UA_IPHONE) : defaultUA.current
    try {
      if (want && wv.getUserAgent() !== want) {
        wv.setUserAgent(want)
        wv.reload()
      }
    } catch {
      /* ignore */
    }
  }, [deviceId, ready, device])

  const go = (raw: string) => {
    const u = normalizeUrl(raw)
    setEditingAddr(false)
    setError(null)
    if (!u) return set({ url: '' })
    const wv = wvRef.current
    if (wv && ready) {
      wv.loadURL(u).catch(() => {})
      set({ url: u })
    } else set({ url: u })
  }
  const call = (fn: (wv: WebviewTag) => void) => {
    const wv = wvRef.current
    if (wv && ready) {
      try {
        fn(wv)
      } catch {
        /* ignore */
      }
    }
  }

  // stage size → device scale
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: node.w, h: node.h - 40 })
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasView])
  const inset = device?.phone ? 20 : 12
  const scale = device ? Math.min((stage.w - inset * 2) / device.w, (stage.h - inset * 2) / device.h) : 1
  const frameStyle: React.CSSProperties = device
    ? {
        width: device.w,
        height: device.h,
        left: (stage.w - device.w * scale) / 2,
        top: (stage.h - device.h * scale) / 2,
        transform: `scale(${scale})`
      }
    : { inset: 0 }

  return (
    <div className="web">
      <div className="web-bar">
        <button className="icon-btn sm" title="Back" disabled={!nav.back} onClick={() => call((w) => w.goBack())}>
          <ArrowLeft size={14} />
        </button>
        <button className="icon-btn sm" title="Forward" disabled={!nav.fwd} onClick={() => call((w) => w.goForward())}>
          <ArrowRight size={14} />
        </button>
        <button
          className="icon-btn sm"
          title={loading ? 'Stop' : 'Reload'}
          disabled={!hasView}
          onClick={() => call((w) => (loading ? w.stop() : w.reload()))}
        >
          {loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <div className={`web-addr ${loading ? 'loading' : ''}`}>
          <Globe size={12} className="web-addr-ic" />
          <input
            value={editingAddr ? addr : prettyUrl(addr)}
            placeholder="Enter a URL or a port like 3000"
            spellCheck={false}
            onFocus={(e) => {
              setEditingAddr(true)
              setAddr(url)
              requestAnimationFrame(() => e.target.select())
            }}
            onBlur={() => setEditingAddr(false)}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                go(addr)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setAddr(url)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </div>
        <div className="web-dev-wrap">
          <button className={`web-dev ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} title="Device">
            {device?.phone ? <Smartphone size={13} /> : <Monitor size={13} />}
            <span>{device ? device.label : 'Fit tile'}</span>
            <ChevronDown size={12} />
          </button>
          {menu && (
            <DeviceMenu
              value={deviceId}
              onClose={() => setMenu(false)}
              onPick={(id) => {
                set({ device: id === 'fit' ? undefined : id })
                setMenu(false)
              }}
            />
          )}
        </div>
        <button className="icon-btn sm" title="Inspector" disabled={!ready} onClick={() => call((w) => invoke('webview:devtools', w.getWebContentsId()))}>
          <Bug size={13} />
        </button>
        <button className="icon-btn sm" title="Open a page" onClick={() => set({ url: '' })} disabled={!hasView}>
          <LayoutGrid size={13} />
        </button>
      </div>

      <div ref={stageRef} className={`web-stage ${device ? 'device' : ''} ${active ? 'no-board-wheel' : ''}`}>
        {hasView ? (
          <>
            <div className={`web-frame ${device?.phone ? 'phone' : ''} ${device ? 'scaled' : ''}`} style={frameStyle}>
              <webview ref={wvRef as any} src={mountSrc.current} partition="persist:fleetboard-web" className="web-view" />
            </div>
            {loading && <div className="web-progress" />}
            {error && (
              <div className="web-error">
                <div className="web-error-title">This page didn’t load</div>
                <div className="muted small">{error}</div>
                <button className="btn sm" onClick={() => call((w) => w.reload())}>
                  <RotateCw size={12} /> Retry
                </button>
              </div>
            )}
          </>
        ) : (
          <OpenPage onOpen={go} />
        )}
        {hasView && !active && <div className="web-shield" title="Click to interact" />}
      </div>
    </div>
  )
}

function DeviceMenu({ value, onPick, onClose }: { value: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, true, onClose)
  const item = (d: { id: string; label: string; w?: number; h?: number }) => (
    <button key={d.id} className={`menu-item ${value === d.id ? 'on' : ''}`} onClick={() => onPick(d.id)}>
      <span className="web-check">{value === d.id && <Check size={12} />}</span>
      <span className="grow">{d.label}</span>
      {d.w && (
        <span className="mono dim small">
          {d.w}×{d.h}
        </span>
      )}
    </button>
  )
  return (
    <div ref={ref} className="menu web-menu">
      {item({ id: 'fit', label: 'Fit tile' })}
      <div className="menu-sep" />
      <div className="menu-label label">Displays</div>
      {DISPLAYS.map(item)}
      <div className="menu-label label">Phones</div>
      {PHONES.map(item)}
    </div>
  )
}

function OpenPage({ onOpen }: { onOpen: (u: string) => void }) {
  const [live, setLive] = useState<Record<number, boolean>>({})
  const [q, setQ] = useState('')
  // probe common dev ports so running servers stand out
  useEffect(() => {
    let alive = true
    for (const { port } of PORTS) {
      const ctl = new AbortController()
      const t = window.setTimeout(() => ctl.abort(), 900)
      fetch(`http://localhost:${port}/`, { mode: 'no-cors', signal: ctl.signal })
        .then(() => alive && setLive((l) => ({ ...l, [port]: true })))
        .catch(() => alive && setLive((l) => ({ ...l, [port]: false })))
        .finally(() => window.clearTimeout(t))
    }
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="web-open scrollable">
      <div className="web-open-inner">
        <div className="web-open-title">
          Open a <em>page</em>
        </div>
        <input
          className="input web-open-input"
          placeholder="URL, search, or a port like 3000"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && q.trim() && onOpen(q)}
        />
        <div className="label web-open-label">Local dev servers</div>
        <div className="web-tiles">
          {PORTS.map((p) => (
            <button key={p.port} className={`web-tile port ${live[p.port] ? 'live' : ''}`} onClick={() => onOpen(String(p.port))}>
              <span className={`dot ${live[p.port] ? 'live' : ''}`} />
              <span className="web-tile-main mono">:{p.port}</span>
              <span className="web-tile-sub">{live[p.port] ? 'Running' : p.hint}</span>
            </button>
          ))}
        </div>
        <div className="label web-open-label">Quick links</div>
        <div className="web-tiles">
          {LINKS.map((l) => (
            <button key={l.name} className="web-tile" onClick={() => onOpen(l.url)}>
              <span className="web-mono" style={{ background: l.color }}>
                {l.name[0]}
              </span>
              <span className="web-tile-main">{l.name}</span>
              <span className="web-tile-sub">{prettyUrl(l.url).replace(/^www\./, '')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
