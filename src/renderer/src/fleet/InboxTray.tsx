import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleX, Maximize2, MessageCircleQuestion, MessageSquareText, OctagonAlert, ShieldAlert, ShieldQuestion, TerminalSquare, TriangleAlert } from 'lucide-react'
import type { MergeReview } from '@shared/mergeReview'
import { billed, type Spent } from '@shared/spend'
import { agentColor } from '../engine/consoles'
import { allConsoles } from '../state/store'
import { ago, cycleFront, frontItem, openConsole, runAction, setFront, toggleInbox, useInbox, type InboxItem } from './inboxModel'

// The Inbox, docked on top of the command bar: the front item in full, the rest a click (or Ctrl+I)
// away. Number keys, Tab and Enter in the bar answer it (CommandBar.tsx); voice too (planner.ts).

const KIND_ICON = { approval: ShieldQuestion, ask: MessageCircleQuestion, ready: CircleCheck, stopped: OctagonAlert, notice: CircleX } as const

function iconOf(i: InboxItem) {
  if (i.kind === 'notice' && i.tone === 'info') return MessageSquareText
  return KIND_ICON[i.kind]
}
const toneOf = (i: InboxItem) => (i.kind === 'approval' || i.kind === 'stopped' ? 'warn' : i.kind === 'ask' ? 'accent' : i.kind === 'ready' ? 'ok' : i.tone === 'danger' ? 'danger' : 'info')
const headOf = (i: InboxItem) =>
  i.kind === 'approval' ? (i.approval ? 'asks' : 'is waiting for you') : i.kind === 'ask' ? 'asks' : i.kind === 'ready' ? 'finished the goal' : i.kind === 'stopped' ? 'stopped before finishing' : i.head
const blocks = (i: InboxItem) => i.kind === 'approval' || i.kind === 'ask' || i.kind === 'stopped'

export function InboxTray({ floating }: { floating?: boolean }) {
  const items = useInbox((s) => s.items)
  const open = useInbox((s) => s.open) && !floating
  useInbox((s) => s.front)
  const item = frontItem()
  if (!item) return null
  const n = items.length
  const idx = items.indexOf(item)
  const need = items.filter(blocks).length
  const Icon = iconOf(item)
  const tone = toneOf(item)
  const dot = item.consoleId ? agentColor((allConsoles().find((c) => c.id === item.consoleId)?.data.agentId as string) ?? '') : undefined

  return (
    <div className={`inbox-tray ${floating ? 'floating' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="it-top">
        <span className="it-count">
          {need > 0 && <b>{need} need{need === 1 ? 's' : ''} you</b>}
          {need > 0 && ' · '}
          {n} in inbox
        </span>
        <span className="spacer" />
        {n > 1 && (
          <>
            <button className="icon-btn sm" title="Previous (Shift+Tab)" onClick={() => cycleFront(-1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="it-pos">
              {idx + 1} of {n}
            </span>
            <button className="icon-btn sm" title="Next (Tab)" onClick={() => cycleFront(1)}>
              <ChevronRight size={14} />
            </button>
          </>
        )}
        {!floating && n > 1 && (
          <button className="btn sm ghost it-all" title="Ctrl+I" onClick={toggleInbox}>
            {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />} {open ? 'Collapse' : 'Show all'}
          </button>
        )}
      </div>

      {open && (
        <div className="it-list">
          {items.map((x) => {
            const XI = iconOf(x)
            return (
              <button key={x.key} className={`it-li ${x.key === item.key ? 'on' : ''}`} onClick={() => setFront(x.key)}>
                <XI size={14} className={`it-ic ${toneOf(x)}`} />
                <b>{x.who}</b>
                <span className="it-li-head">{headOf(x)}</span>
                <span className="spacer" />
                <span className="it-meta">{ago(x.since)}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="it-card" key={item.key} data-kind={item.kind}>
        <div className="it-head">
          <span className={`it-av ${tone}`}>
            <Icon size={15} />
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="it-title">
              {dot && <span className="agent-dot" style={{ background: dot }} />}
              <b>{item.who}</b> <span className="it-headtext">{headOf(item)}</span>
            </div>
            <div className="it-meta">
              {[item.sub, item.kind === 'ask' ? item.ask && progressOf(item) : '', item.kind === 'ready' ? readyMeta(item) : `${item.kind === 'notice' ? '' : 'waiting '}${ago(item.since)}${item.kind === 'notice' ? ' ago' : ''}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          {item.consoleId && (
            <button className="icon-btn sm" title="Open the console full screen" onClick={() => openConsole(item.consoleId!)}>
              <Maximize2 size={13} />
            </button>
          )}
        </div>
        <div className="it-body">
          <Body item={item} />
          {item.kind !== 'ask' && (
            <div className="it-actions">
              {item.actions.map((a, i) => (
                <button key={a.label} className={`btn sm ${a.primary ? 'primary' : a.tone === 'deny' ? 'ghost' : ''}`} data-key={i < 9 ? i + 1 : undefined} onClick={() => runAction(item, i)}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const progressOf = (i: Extract<InboxItem, { kind: 'ask' }>) => i.progress
function readyMeta(i: Extract<InboxItem, { kind: 'ready' }>) {
  const mins = i.lead ? Math.max(1, Math.round((i.ready.at - i.lead.createdAt) / 60000)) : 0
  return [mins ? `${mins < 60 ? `${mins} min` : `${Math.round(mins / 6) / 10} h`}` : '', i.workers ? `${i.workers} worker${i.workers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
}

// What the team was told to do, next to what it actually did. It only ever annotates: a legitimate
// out-of-scope change is common enough that a gate here would teach you to click through it, and
// then it would be guarding nothing. Merge stays enabled; the flags are for reading first.
/** 1.2M, 48k, 900 — a size, not an exact count; the point is which member was expensive. */
const tokens = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

function Review({ review, spend }: { review: MergeReview | null; spend: Record<string, Spent | null> }) {
  if (!review) return null
  const { claims, unowned, risks } = review
  if (!claims.length && !unowned.length && !risks.length) return null
  const outside = unowned.slice(0, 2).join(', ') + (unowned.length > 2 ? ` +${unowned.length - 2}` : '')
  return (
    <div className="it-review">
      {claims.map((c, i) => {
        const s = spend[c.cwd]
        const spent = s ? billed(s) : 0
        return (
          <div key={i} className={`it-claim ${c.proven ? 'ok' : 'warn'}`}>
            {c.proven ? <Check size={12} /> : <TriangleAlert size={12} />}
            <span className="it-claim-who">{c.who}</span>
            <span className="it-claim-what">{c.doneWhen}</span>
            {spent ? <span className="it-claim-spend">{tokens(spent)}</span> : null}
            <span className="it-claim-ev">{c.proven ? c.report?.split('\n')[0] ?? 'merged' : c.gap}</span>
          </div>
        )
      })}
      {unowned.length > 0 && (
        <div className="it-claim warn">
          <ArrowUpRight size={12} />
          <span className="it-claim-what mono">{outside}</span>
          <span className="it-claim-ev">
            outside what {claims.length === 1 ? 'it was' : 'the team was'} granted
          </span>
        </div>
      )}
      {risks.map((x) => (
        <div key={x.path} className="it-claim risk">
          <ShieldAlert size={12} />
          <span className="it-claim-what mono">{x.path}</span>
          <span className="it-claim-ev">{x.why}</span>
        </div>
      ))}
    </div>
  )
}

function Body({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'approval': {
      const ap = item.approval
      return (
        <>
          {item.context.length > 0 && (
            <div className="it-ctx">
              {item.context.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
          {ap?.title && <div className="it-q">{ap.title}</div>}
          {ap?.detail && (
            <div className="it-cmd">
              <TerminalSquare size={13} />
              <span>{ap.detail}</span>
            </div>
          )}
          {item.note && <div className="it-meta">{item.note}</div>}
          {!ap && <div className="it-meta">Its question isn't one Fleetboard can read. Open the console to answer it.</div>}
        </>
      )
    }
    case 'ask': {
      const a = item.ask
      return (
        <>
          <div className="it-q">{a.question}</div>
          <div className="it-opts">
            {a.options.map((o, i) => (
              <button key={o} className={`it-opt ${a.recommended === i ? 'rec' : ''}`} onClick={() => runAction(item, i)}>
                <span className="it-opt-top" data-key={i + 1}>
                  {o}
                  {a.recommended === i && <span className="it-rec">{item.who} suggests</span>}
                </span>
                {a.notes?.[i] && <span className="it-opt-note">{a.notes[i]}</span>}
              </button>
            ))}
          </div>
        </>
      )
    }
    case 'ready': {
      const r = item.ready
      const lines = r.summary
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const bullets = lines.filter((l) => /^[-*•]\s/.test(l)).map((l) => l.replace(/^[-*•]\s+/, ''))
      const stat = [...(r.stat ?? [])].sort((a, b) => b.add + b.del - (a.add + a.del))
      const shown = stat.slice(0, 3)
      const rest = stat.slice(3)
      return (
        <>
          {bullets.length ? (
            <ul className="it-bullets">
              {bullets.slice(0, 4).map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : (
            <div className="it-summary">{lines.join(' ')}</div>
          )}
          {shown.length > 0 && (
            <div className="it-ctx it-files">
              {shown.map((f) => (
                <div key={f.path}>
                  <span className="it-path">{f.path}</span>
                  <span className="add">+{f.add}</span>
                  <span className="del">−{f.del}</span>
                </div>
              ))}
              {rest.length > 0 && (
                <div>
                  <span className="it-path">
                    … {rest.length} more file{rest.length === 1 ? '' : 's'}
                  </span>
                  <span className="add">+{rest.reduce((n, f) => n + f.add, 0)}</span>
                  <span className="del">−{rest.reduce((n, f) => n + f.del, 0)}</span>
                </div>
              )}
            </div>
          )}
          <Review review={item.review} spend={item.spend} />
          <div className="it-foot">
            {r.verified && (
              <span className="it-verified">
                <Check size={12} /> {r.verified}
              </span>
            )}
            <span className="spacer" />
            {r.branch && (
              <span className="it-meta mono">
                {r.branch} · {r.commits} commit{r.commits === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </>
      )
    }
    case 'stopped':
      return <div className="it-q">Its console exited mid-task. Resume it on its tile to carry on (it's told where the team is), or discard the team's work.</div>
    case 'notice':
      return item.lines.length ? (
        <div className="it-ctx">
          {item.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null
  }
}
