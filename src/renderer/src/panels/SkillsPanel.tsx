import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Plus, RefreshCw, Save, Sparkles, Terminal, Trash2 } from 'lucide-react'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'
import { agentColor, sendToConsole } from '../engine/consoles'
import { pushTargets, type PushTarget } from '../continuity/memory'
import { Modal, Seg } from '../ui/Modal'
import type { SkillInfo } from '../continuity/types'
import { mayDropUnsaved, setUnsaved } from '../lib/unsaved'

interface SkillList {
  user: SkillInfo[]
  project: SkillInfo[]
  roots: { user: string; project: string | null }
}

const TEMPLATE = `## When to use

Describe the situations where Claude should reach for this skill.

## Steps

1.
2.
3.

## Notes

- `

/** Claude Code skills (SKILL.md folders): browse, edit, create, delete, and invoke them in a console. */
export default function SkillsPanel() {
  const projectPath = useApp((s) => s.project?.path)
  const [data, setData] = useState<SkillList | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'new'>('view')
  // another skill replaces the editor, and with it any unsaved edits
  const pick = async (file: string) => {
    if (file === sel && mode === 'view') return
    if (!(await mayDropUnsaved('Open another skill'))) return
    setSel(file)
    setMode('view')
  }

  const load = useCallback(async () => {
    const d = await invoke<SkillList>('skills:list', projectPath)
    setData(d)
    return d
  }, [projectPath])
  useEffect(() => {
    load().then((d) => {
      const first = d.project[0] ?? d.user[0]
      if (first) setSel(first.file)
      else setMode('new')
    })
  }, [load])

  const all = useMemo(() => (data ? [...data.project, ...data.user] : []), [data])
  const skill = all.find((s) => s.file === sel) ?? null

  return (
    <Modal
      onClose={async () => (await mayDropUnsaved('Close skills')) && useApp.getState().closePanel()}
      title="Skills"
      sub="Claude Code skills — reusable instructions Claude loads when a task matches, or you call with /name."
      icon={<Sparkles size={17} />}
      width={880}
      height={600}
      bare
      headerRight={
        <button className="icon-btn" title="Rescan" onClick={load}>
          <RefreshCw size={14} />
        </button>
      }
    >
      <div className="skills">
        <div className="skills-list scrollable">
          <button className={`skills-new ${mode === 'new' ? 'on' : ''}`} onClick={async () => (await mayDropUnsaved('Start a new skill')) && setMode('new')}>
            <Plus size={13} /> New skill
          </button>
          {projectPath && <Section title="This project" items={data?.project ?? []} sel={mode === 'view' ? sel : null} onPick={(f) => void pick(f)} empty=".claude/skills/ is empty" />}
          <Section title="Personal" items={data?.user ?? []} sel={mode === 'view' ? sel : null} onPick={(f) => void pick(f)} empty="~/.claude/skills/ is empty" />
        </div>
        <div className="skills-main">
          {mode === 'new' ? (
            <NewSkill
              projectPath={projectPath}
              onCreated={async (file) => {
                await load()
                setSel(file)
                setMode('view')
              }}
            />
          ) : skill ? (
            <SkillDetail
              key={skill.file}
              skill={skill}
              projectPath={projectPath}
              onDeleted={async () => {
                const d = await load()
                setSel((d.project[0] ?? d.user[0])?.file ?? null)
              }}
            />
          ) : (
            <div className="empty">Pick a skill</div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Section({ title, items, sel, onPick, empty }: { title: string; items: SkillInfo[]; sel: string | null; onPick: (file: string) => void; empty: string }) {
  return (
    <>
      <div className="label skills-section">
        {title} <span className="dim">{items.length}</span>
      </div>
      {items.length === 0 && <div className="dim small" style={{ padding: '2px 10px 8px' }}>{empty}</div>}
      {items.map((s) => (
        <button key={s.file} className={`skills-item ${sel === s.file ? 'on' : ''}`} onClick={() => onPick(s.file)}>
          <span className="skills-item-name">/{s.slug}</span>
          <span className="skills-item-desc">{s.description || 'No description'}</span>
        </button>
      ))}
    </>
  )
}

function SkillDetail({ skill, projectPath, onDeleted }: { skill: SkillInfo; projectPath?: string; onDeleted: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const dirty = text !== null && text !== saved
  // so quitting, or picking another skill, asks before these edits go (lib/unsaved.ts)
  useEffect(() => {
    setUnsaved('skill', dirty ? `/${skill.slug}` : null)
    return () => setUnsaved('skill', null)
  }, [dirty, skill.slug])

  useEffect(() => {
    invoke<string>('skills:read', skill.file, projectPath).then((t) => {
      setText(t)
      setSaved(t)
    })
  }, [skill.file, projectPath])

  const save = async () => {
    if (text === null) return
    await invoke('skills:save', skill.file, text, projectPath)
    setSaved(text)
    useApp.getState().toast(`Saved /${skill.slug}`, 'ok')
  }
  const remove = async () => {
    const ok = await useApp.getState().confirm({
      title: `Delete /${skill.slug}?`,
      body: `Removes ${skill.dir} and every file in it (${skill.files}). This can't be undone.`,
      confirm: 'Delete skill',
      danger: true
    })
    if (!ok) return
    await invoke('skills:delete', skill.dir, projectPath)
    onDeleted()
  }

  return (
    <div className="skills-detail">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="skills-title">
            /{skill.slug} <span className="pill">{skill.scope === 'project' ? 'project' : 'personal'}</span>
          </div>
          <div className="muted small" style={{ marginTop: 3, lineHeight: 1.45 }}>
            {skill.description}
          </div>
          <div className="dim small mono" style={{ marginTop: 4 }}>
            {skill.dir}
          </div>
        </div>
        <UseInConsole slug={skill.slug} />
      </div>
      <textarea
        className="textarea mono skills-editor no-board-wheel"
        spellCheck={false}
        value={text ?? ''}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="row">
        <button className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={remove}>
          <Trash2 size={12} /> Delete
        </button>
        <button className="btn ghost sm" onClick={() => invoke('skills:open', skill.dir, projectPath)}>
          <FolderOpen size={12} /> Open folder
        </button>
        <span className="spacer" />
        {dirty && <span className="dim small">unsaved</span>}
        <button className="btn primary sm" disabled={!dirty} onClick={save}>
          <Save size={12} /> Save
        </button>
      </div>
    </div>
  )
}

function UseInConsole({ slug }: { slug: string }) {
  // one JSON string rather than "id|name|agentId" per console: a console may be named anything, and
  // a name holding the delimiter used to hand its fields to the wrong columns (see continuity/memory)
  const rows = useApp((s) => (s.project ? JSON.stringify(pushTargets(s.project, s.live).filter((t) => t.live)) : '[]'))
  const [open, setOpen] = useState(false)
  const list = useMemo(() => JSON.parse(rows) as PushTarget[], [rows])
  const send = (id: string, name: string) => {
    sendToConsole(id, `/${slug}`, false)
    setOpen(false)
    useApp.getState().toast(`Typed /${slug} into ${name} — add details and press Enter`, 'ok')
  }
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn sm" disabled={!list.length} title={list.length ? '' : 'No running consoles'} onClick={() => setOpen(!open)}>
        <Terminal size={12} /> Use in console
      </button>
      {open && (
        <div className="menu" style={{ top: 30, right: 0, width: 220 }} onMouseLeave={() => setOpen(false)}>
          <div className="menu-label label">Type /{slug} into</div>
          {list
            .sort((a, b) => Number(b.agentId === 'claude') - Number(a.agentId === 'claude'))
            .map((c) => (
              <button key={c.id} className="menu-item" onClick={() => send(c.id, c.name)}>
                <span className="dot" style={{ background: agentColor(c.agentId) }} />
                <span className="grow">{c.name}</span>
                {c.agentId !== 'claude' && <span className="dim small">{c.agentId}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

function NewSkill({ projectPath, onCreated }: { projectPath?: string; onCreated: (file: string) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(TEMPLATE)
  const [scope, setScope] = useState<'user' | 'project'>(projectPath ? 'project' : 'user')
  const [err, setErr] = useState<string | null>(null)
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const create = async () => {
    setErr(null)
    try {
      const r = await invoke<{ file: string }>('skills:create', { scope, projectPath, name, description, body: `# ${name}\n\n${body}` })
      useApp.getState().toast(`Created /${slug}`, 'ok')
      onCreated(r.file)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div className="skills-detail">
      <div className="skills-title">New skill</div>
      <div className="row">
        <div className="grow">
          <div className="label" style={{ margin: '4px 0 6px' }}>
            Name
          </div>
          <input className="input" autoFocus placeholder="e.g. release-notes" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="label" style={{ margin: '4px 0 6px' }}>
            Saved in
          </div>
          <Seg<'user' | 'project'>
            value={scope}
            onChange={setScope}
            options={[...(projectPath ? [{ value: 'project' as const, label: 'This project' }] : []), { value: 'user' as const, label: 'Personal' }]}
          />
        </div>
      </div>
      <div>
        <div className="label" style={{ margin: '4px 0 6px' }}>
          Description <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>— Claude reads this to decide when to use it</span>
        </div>
        <input className="input" placeholder="Use when drafting release notes from merged PRs…" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <textarea className="textarea mono skills-editor no-board-wheel" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row">
        <span className="dim small mono grow">{slug ? `${scope === 'project' ? '.claude/skills' : '~/.claude/skills'}/${slug}/SKILL.md` : ''}</span>
        {err && <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
        <button className="btn primary sm" disabled={!slug || !description.trim()} onClick={create}>
          <Plus size={12} /> Create skill
        </button>
      </div>
    </div>
  )
}
