import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCheck, FolderOpen, GitMerge, Repeat, RefreshCw, ShieldAlert, SquareTerminal } from 'lucide-react'
import { invoke } from '../lib/api'
import { Drawer } from '../ui/Modal'

// What happened while you were not watching, newest first (src/main/journal.ts writes it).
//
// A toast lives 4200 ms, so the night's loops, the goal verdicts, the team's merges and every prompt
// answered on your behalf used to leave nothing behind. The thing you want at 7am is to read down the
// list once: so one line each, the time on the left, and "what did it decide" separable from the rest.

interface Entry {
  at: number
  kind: string
  text: string
  project?: string
  detail?: Record<string, unknown>
}

const ICONS: Record<string, typeof Repeat> = {
  loop: Repeat,
  prompt: ShieldAlert,
  fleet: GitMerge,
  guard: AlertTriangle,
  console: SquareTerminal
}
const area = (kind: string) => kind.split('.')[0] ?? ''

const GROUPS = {
  all: () => true,
  decided: (k: string) => area(k) === 'prompt' || area(k) === 'fleet',
  loops: (k: string) => area(k) === 'loop',
  limits: (k: string) => area(k) === 'guard'
} satisfies Record<string, (kind: string) => boolean>
const LABELS: Record<keyof typeof GROUPS, string> = { all: 'Everything', decided: 'Decisions', loops: 'Loops', limits: 'Limits' }

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (at: number) => {
  const d = new Date(at).toDateString()
  if (d === new Date().toDateString()) return 'Today'
  if (d === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday'
  return new Date(at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function JournalPanel() {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [group, setGroup] = useState<keyof typeof GROUPS>('all')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const load = useCallback(async () => {
    const list = await invoke<Entry[]>('journal:read', { days: 7, limit: 800 }).catch(() => [])
    if (alive.current) setEntries(list)
  }, [])
  useEffect(() => void load(), [load])

  const shown = (entries ?? []).filter((e) => GROUPS[group](e.kind))
  let last = ''

  return (
    <Drawer
      title="Night log"
      icon={<CheckCheck size={14} />}
      width={420}
      headerRight={
        <>
          <button className="icon-btn sm" title="Open the folder" onClick={() => void invoke('journal:dir').then((d) => invoke('shell:openPath', d))}>
            <FolderOpen size={13} />
          </button>
          <button className="icon-btn sm" title="Read it again" onClick={() => void load()}>
            <RefreshCw size={13} />
          </button>
        </>
      }
    >
      <div className="seg" style={{ marginBottom: 10 }}>
        {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) => (
          <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>
            {LABELS[g]}
          </button>
        ))}
      </div>
      {entries === null ? (
        <div className="muted small">Reading…</div>
      ) : !shown.length ? (
        <div className="muted small" style={{ lineHeight: 1.5 }}>
          {group === 'all'
            ? 'Nothing yet. Loops, goal verdicts, a team’s merges and anything answered on your behalf are written down here as they happen.'
            : 'Nothing of that kind in the last week.'}
        </div>
      ) : (
        <div className="journal-list">
          {shown.map((e, i) => {
            const Icon = ICONS[area(e.kind)] ?? CheckCheck
            const header = day(e.at) !== last ? ((last = day(e.at)), last) : null
            return (
              <div key={`${e.at}-${i}`}>
                {header && <div className="label journal-day">{header}</div>}
                <div className={`journal-row ${area(e.kind)}`} title={e.detail ? JSON.stringify(e.detail, null, 1) : e.kind}>
                  <span className="dim mono small journal-at">{time(e.at)}</span>
                  <Icon size={12} className="journal-ic" />
                  <span className="grow small">{e.text}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Drawer>
  )
}
