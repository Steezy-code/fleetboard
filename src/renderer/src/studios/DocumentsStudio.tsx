import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  Copy,
  FileDown,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { Modal, Seg } from '../ui/Modal'
import { useApp } from '../state/store'
import { errorText, invoke, uid } from '../lib/api'
import { AgentPicker, resolveAgent, shortName, useHeadlessAgents } from './docs/AgentPicker'
import { CUSTOM_ICON, DEPTHS, DOC_PRESETS, presetById, slugify, type Depth } from './docs/presets'
import { dismissGen, removeDoc, savedDocs, startDoc, stopDoc, useDocStudio, type DocGen, type SavedDoc } from './docs/state'
import { renderMarkdown } from './docs/render'
import { markdownToHtmlDocument } from '../workbench/pdf'
import '../styles/studios.css'

/** Document studio: the repo turned into a polished, paginated document, written by your own CLI. */
export default function DocumentsStudio(props: { preset?: string }) {
  const project = useApp((s) => s.project)
  const planner = useApp((s) => s.settings.plannerAgent)
  const docs = useMemo(() => savedDocs(project?.extras), [project?.extras])
  const allGens = useDocStudio((s) => s.gens)
  const gens = useMemo(
    () => Object.fromEntries(Object.entries(allGens).filter(([, g]) => g.projectId === project?.id)),
    [allGens, project?.id]
  )
  const selected = useDocStudio((s) => s.selected)
  const depth = useDocStudio((s) => s.depth)
  const agentPref = useDocStudio((s) => s.agentId)
  const agents = useHeadlessAgents()
  const agent = resolveAgent(agentPref, agents, planner)
  const [ask, setAsk] = useState('')

  useEffect(() => {
    if (props.preset && presetById(props.preset)) useDocStudio.setState({ selected: props.preset })
  }, [props.preset])

  const select = (key: string) => useDocStudio.setState({ selected: key })
  const preset = presetById(selected)
  const customDocs = docs.filter((d) => d.preset === 'custom')
  const gen: DocGen | undefined = gens[selected]
  const doc: SavedDoc | undefined = preset ? docs.find((d) => d.preset === preset.id) : docs.find((d) => d.id === selected)
  const runningCustom = Object.values(gens).filter((g) => g.preset === 'custom' && !customDocs.some((d) => d.id === g.key))

  const generate = (key = selected) => {
    const p = presetById(key)
    const request = gens[key]?.request ?? docs.find((d) => d.id === key)?.request
    if (p) startDoc({ key, preset: p.id, agentId: agent.id, depth })
    else if (request) startDoc({ key, preset: 'custom', agentId: agent.id, depth, request })
  }
  const sendAsk = () => {
    const request = ask.trim()
    if (!request) return
    const key = uid('doc')
    startDoc({ key, preset: 'custom', agentId: agent.id, depth, request })
    select(key)
    setAsk('')
  }

  if (!project) return null

  return (
    <Modal
      title="Documents"
      sub="Generate a PDF from your repo — with your CLI."
      icon={<FileText size={17} />}
      width="min(1180px, 95vw)"
      height="86vh"
      bare
    >
      <div className="ds-root">
        <aside className="ds-side">
          <div className="ds-side-scroll scrollable">
            <div className="ds-field">
              <div className="label">Model</div>
              <AgentPicker value={agent.id} onChange={(id) => useDocStudio.setState({ agentId: id })} />
            </div>
            <div className="ds-field">
              <div className="label">Depth</div>
              <div className="ds-depth">
                <Seg<Depth> value={depth} options={DEPTHS.map((d) => ({ value: d.value, label: d.label }))} onChange={(v) => useDocStudio.setState({ depth: v })} />
                <span className="ds-depth-hint">{DEPTHS.find((d) => d.value === depth)?.hint}</span>
              </div>
            </div>

            <div className="label ds-list-label">Documents</div>
            <div className="ds-list">
              {DOC_PRESETS.map((p) => {
                const Icon = p.icon
                const has = docs.some((d) => d.preset === p.id)
                const g = gens[p.id]
                return (
                  <button key={p.id} className={`ds-item ${selected === p.id ? 'on' : ''}`} onClick={() => select(p.id)}>
                    <span className="ds-item-ic">
                      <Icon size={15} />
                    </span>
                    <span className="grow">
                      <span className="ds-item-title">{p.title}</span>
                      <span className="ds-item-sub">{p.sub}</span>
                    </span>
                    <ItemState gen={g} has={has} />
                  </button>
                )
              })}
            </div>

            {(customDocs.length > 0 || runningCustom.length > 0) && (
              <>
                <div className="label ds-list-label">Your documents</div>
                <div className="ds-list">
                  {[...runningCustom.map((g) => ({ id: g.key, title: g.title, createdAt: g.startedAt, gen: g })), ...customDocs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, gen: gens[d.id] }))].map((d) => (
                    <button key={d.id} className={`ds-item ${selected === d.id ? 'on' : ''}`} onClick={() => select(d.id)}>
                      <span className="ds-item-ic">
                        <CUSTOM_ICON size={15} />
                      </span>
                      <span className="grow">
                        <span className="ds-item-title">{d.title}</span>
                        <span className="ds-item-sub">{ago(d.createdAt)}</span>
                      </span>
                      <ItemState gen={d.gen} has={customDocs.some((c) => c.id === d.id)} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="ds-ask">
            <div className="label">Ask for anything</div>
            <div className="ds-ask-box">
              <textarea
                className="textarea"
                rows={3}
                placeholder="e.g. A migration guide from v1 to v2, or a one-pager on how auth works…"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                    e.preventDefault()
                    sendAsk()
                  }
                }}
              />
              <button className="ds-send" disabled={!ask.trim()} onClick={sendAsk} title="Write this document (Enter)">
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </aside>

        <section className="ds-main">
          {gen ? (
            <GenView gen={gen} onRegenerate={() => generate(selected)} />
          ) : doc ? (
            <DoneView doc={doc} agentName={shortName(agent)} onRegenerate={() => generate(selected)} />
          ) : preset ? (
            <EmptyView
              icon={<preset.icon size={30} strokeWidth={1.6} />}
              title={preset.title}
              sub={preset.sub}
              blurb={preset.blurb}
              agentName={shortName(agent)}
              depth={depth}
              onGenerate={() => generate(preset.id)}
            />
          ) : (
            <div className="ds-empty">
              <div className="muted">Pick a document on the left, or ask for anything.</div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  )
}

function ItemState({ gen, has }: { gen?: DocGen; has: boolean }) {
  if (gen?.status === 'running') return <LoaderCircle size={14} className="spin ds-item-state" />
  if (gen?.status === 'error') return <TriangleAlert size={13} className="ds-item-state warn" />
  if (has) return <span className="ds-item-dot" title="Generated — opens instantly" />
  return null
}

function EmptyView(p: { icon: React.ReactNode; title: string; sub: string; blurb: string; agentName: string; depth: Depth; onGenerate: () => void }) {
  const d = DEPTHS.find((x) => x.value === p.depth)!
  return (
    <div className="ds-empty">
      <div className="ds-empty-card">
        <div className="ds-empty-ic">{p.icon}</div>
        <h2 className="ds-empty-title">{p.title}</h2>
        <div className="ds-empty-sub">{p.sub}</div>
        <p className="ds-empty-blurb">{p.blurb}</p>
        <button className="btn primary ds-cta" onClick={p.onGenerate}>
          <Sparkles size={15} /> Generate with {p.agentName}
        </button>
        <div className="ds-empty-meta">
          {d.label} · {d.eta} · reads your repo with read-only tools
        </div>
      </div>
      <div className="ds-ghost-paper" aria-hidden>
        <div className="ds-skel h1" />
        <div className="ds-skel" />
        <div className="ds-skel" />
        <div className="ds-skel short" />
      </div>
    </div>
  )
}

function useElapsed(since: number, running: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running])
  const s = Math.max(0, Math.round((now - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function GenView({ gen, onRegenerate }: { gen: DocGen; onRegenerate: () => void }) {
  const running = gen.status === 'running'
  const elapsed = useElapsed(gen.startedAt, running)
  const agents = useHeadlessAgents()
  const name = shortName(agents.find((a) => a.id === gen.agentId))

  return (
    <>
      <div className="ds-bar">
        <div className="grow ds-bar-title">
          <div className="ds-title">{gen.title}</div>
          {running ? (
            <div className="ds-status">
              <span className="status-dot pulse" style={{ ['--st' as any]: 'var(--accent)' }} />
              <span>
                Writing with {name} · {elapsed}
              </span>
              <span className="ds-activity mono" title={gen.activity}>
                {gen.activity}
              </span>
            </div>
          ) : gen.status === 'stopped' ? (
            <div className="ds-status muted">Stopped — this partial draft was not saved.</div>
          ) : (
            <div className="ds-status warn">The CLI did not return a document.</div>
          )}
        </div>
        {running ? (
          <button className="btn danger" onClick={() => stopDoc(gen.key)}>
            <Square size={11} fill="currentColor" /> Stop
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={() => dismissGen(gen.key)} title="Discard and go back">
              Discard
            </button>
            {gen.markdown && <CopyButton text={gen.markdown} />}
            <button className="btn primary" onClick={onRegenerate}>
              <RotateCcw size={14} /> {gen.status === 'error' ? 'Try again' : 'Regenerate'}
            </button>
          </>
        )}
      </div>
      {gen.status === 'error' ? (
        <div className="ds-stage scrollable">
          <div className="ds-error">
            <TriangleAlert size={18} />
            <div>
              <b>No document came out of this run.</b>
              <pre>{gen.error}</pre>
            </div>
          </div>
        </div>
      ) : (
        <Paper markdown={gen.markdown} streaming={running} />
      )}
    </>
  )
}

function DoneView({ doc, agentName, onRegenerate }: { doc: SavedDoc; agentName: string; onRegenerate: () => void }) {
  const project = useApp((s) => s.project)!
  const [busy, setBusy] = useState<string | null>(null)
  const slug = slugify(doc.title.replace(new RegExp(`^${escapeRe(project.name)}\\s*[—–-]\\s*`, 'i'), ''))
  const agents = useHeadlessAgents()
  const madeWith = doc.agentId ? shortName(agents.find((a) => a.id === doc.agentId)) : agentName

  const exportPdf = async () => {
    const path = await invoke<string | null>('dialog:saveFile', `${slug}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
    if (!path) return
    setBusy('pdf')
    try {
      await invoke('pdf:fromHtml', markdownToHtmlDocument(doc.markdown, doc.title), path)
      invoke('shell:openPath', path)
      useApp.getState().toast('PDF exported', 'ok')
    } catch (e: any) {
      useApp.getState().toast(`PDF export failed: ${errorText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }
  const saveMd = async () => {
    const path = await invoke<string | null>('dialog:saveFile', `${project.path.replace(/\/+$/, '')}/docs/${slug}.md`, [
      { name: 'Markdown', extensions: ['md'] }
    ])
    if (!path) return
    await invoke('fs:write', path, doc.markdown)
    useApp.getState().toast(`Saved ${path.startsWith(project.path) ? path.slice(project.path.length + 1) : path}`, 'ok')
  }
  const place = () => {
    const app = useApp.getState()
    const id = app.addNode({ type: 'doc', w: 520, h: 680, title: doc.title, data: { markdown: doc.markdown, title: doc.title } })
    app.closePanel()
    setTimeout(() => useApp.getState().focusItem(id), 60)
  }
  const remove = async () => {
    const ok = await useApp.getState().confirm({ title: `Delete “${doc.title}”?`, body: 'Removes it from this project’s documents. Files you saved stay on disk.', confirm: 'Delete', danger: true })
    if (ok) removeDoc(doc.id)
  }

  return (
    <>
      <div className="ds-bar">
        <div className="grow ds-bar-title">
          <div className="ds-title">{doc.title}</div>
          <div className="ds-status muted">
            <Check size={12} className="ok" /> Written by {madeWith}
            {doc.depth ? ` · ${DEPTHS.find((d) => d.value === doc.depth)?.label}` : ''} · {ago(doc.createdAt)} · {wordCount(doc.markdown)} words
          </div>
        </div>
        <button className="btn ghost" onClick={onRegenerate} title="Write it again from the current repo">
          <RotateCcw size={14} /> Regenerate
        </button>
        <CopyButton text={doc.markdown} />
        <button className="btn" onClick={saveMd} title={`Save to docs/${slug}.md`}>
          <Save size={14} /> Save .md
        </button>
        <button className="btn" onClick={place}>
          <LayoutDashboard size={14} /> Place on board
        </button>
        <button className="btn primary" onClick={exportPdf} disabled={busy === 'pdf'}>
          {busy === 'pdf' ? <LoaderCircle size={14} className="spin" /> : <FileDown size={14} />} Export PDF
        </button>
        {doc.preset === 'custom' && (
          <button className="icon-btn" onClick={remove} title="Delete document">
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <Paper markdown={doc.markdown} streaming={false} />
    </>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : 'Copy markdown'}
    </button>
  )
}

/** The white page. Streams: re-rendered whenever the (throttled) markdown changes, follows the tail. */
function Paper({ markdown, streaming }: { markdown: string; streaming: boolean }) {
  const stage = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const html = useMemo(() => renderMarkdown(markdown), [markdown])

  useEffect(() => {
    const el = stage.current
    if (el && streaming && follow.current) el.scrollTop = el.scrollHeight
  }, [html, streaming])
  useEffect(() => {
    if (!streaming && stage.current && !markdown) stage.current.scrollTop = 0
  }, [streaming, markdown])

  const onScroll = () => {
    const el = stage.current
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) invoke('shell:openExternal', href)
  }

  return (
    <div className="ds-stage scrollable no-board-wheel" ref={stage} onScroll={onScroll}>
      <article className={`md paper ds-paper ${streaming ? 'streaming' : ''}`} onClick={onClick}>
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="ds-skeleton">
            <div className="ds-skel h1" />
            <div className="ds-skel bar" />
            <div className="ds-skel" />
            <div className="ds-skel" />
            <div className="ds-skel short" />
            <div className="ds-skel h2" />
            <div className="ds-skel" />
            <div className="ds-skel" />
            <div className="ds-skel mid" />
            <div className="ds-skel h2" />
            <div className="ds-skel" />
            <div className="ds-skel short" />
          </div>
        )}
        {streaming && html && <span className="ds-caret" />}
      </article>
    </div>
  )
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordCount = (md: string) => (md.match(/[A-Za-z0-9_'’-]+/g) ?? []).length.toLocaleString()

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  const d = Math.round(s / 86400)
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString()
}
