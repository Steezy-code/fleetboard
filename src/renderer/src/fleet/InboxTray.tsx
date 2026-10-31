import { useEffect, useRef, useState } from 'react'
import { completionMotion } from '../ui/completionMotion'
import { useMotion } from '../ui/motion'
import { arrivedKeys, eventDuration } from '@shared/motion'
import { request, errorText } from '../lib/api'
import { useApp } from '../state/store'
import { commandLike } from '@shared/live'
import { useFleet } from '../engine/fleet'
import { verificationOf } from '@shared/mergeReview'
import { ArrowUpRight, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleX, ClipboardCheck, Maximize2, MessageCircleQuestion, MessageSquareText, Minus, OctagonAlert, ShieldAlert, ShieldQuestion, TerminalSquare, TriangleAlert, X } from 'lucide-react'
import { Fragment } from 'react'
import { removeRule } from './teamRules'
import type { MergeReview } from '@shared/mergeReview'
import { decisionsOf } from '@shared/live'
import { billed, type Spent } from '@shared/spend'
import { agentColor } from '../engine/consoles'
import { allConsoles } from '../state/store'
import { Tip } from '../chrome/Tip'
import { CharterCard } from './CharterCard'
import { ago, charterHead, cycleFront, frontItem, openConsole, runAction, setFront, toggleFolded, toggleInbox, useInbox, type InboxItem } from './inboxModel'

// The Inbox, docked on top of the command bar: the front item in full, the rest a click (or Ctrl+I)
// away. Number keys, Tab and Enter in the bar answer it (CommandBar.tsx); voice too (planner.ts).

const KIND_ICON = { charter: ClipboardCheck, approval: ShieldQuestion, ask: MessageCircleQuestion, ready: CircleCheck, stopped: OctagonAlert, notice: CircleX } as const

/** Finished work that cannot be merged is not a finished job: the whole card says so, not only its body. */
const readyBlocked = (i: InboxItem) => i.kind === 'ready' && !!i.review?.blocked

function iconOf(i: InboxItem) {
  if (i.kind === 'notice' && i.tone === 'info') return MessageSquareText
  if (readyBlocked(i)) return TriangleAlert
  return KIND_ICON[i.kind]
}
const toneOf = (i: InboxItem) =>
  readyBlocked(i) || i.kind === 'approval' || i.kind === 'stopped' ? 'warn' : i.kind === 'ask' || i.kind === 'charter' ? 'accent' : i.kind === 'ready' ? 'ok' : i.tone === 'danger' ? 'danger' : 'info'
function headOf(i: InboxItem): string {
  if (i.kind === 'charter') return charterHead(i.charter)
  if (i.kind === 'approval') return i.approval ? 'asks' : 'is waiting for you'
  if (i.kind === 'ask') return 'asks'
  if (i.kind === 'ready') return readyBlocked(i) ? 'finished, but touched what you ruled out' : 'finished the goal'
  if (i.kind === 'stopped') return 'stopped before finishing'
  return i.head
}
const blocks = (i: InboxItem) => i.kind === 'charter' || i.kind === 'approval' || i.kind === 'ask' || i.kind === 'stopped'

export function InboxTray({ floating }: { floating?: boolean }) {
  const items = useInbox((s) => s.items)
  const folded = useInbox((s) => s.folded)
  const open = useInbox((s) => s.open) && !floating && !folded
  useInbox((s) => s.front)
  const item = frontItem()
  const motion = useMotion()
  const card = useRef<HTMLDivElement>(null)
  const tray = useRef<HTMLDivElement>(null)
  const seenKeys = useRef<Set<string> | null>(null)
  const seenReady = useRef<string | null>(null)
  const ready = item?.kind === 'ready' ? item.ready : null
  const readyKey = ready ? `${ready.leadId}:${ready.at}:${ready.head ?? ''}` : null
  const readyLead = ready?.leadId
  const readyAt = ready?.at
  useEffect(() => {
    if (!readyLead || readyAt == null || !readyKey || seenReady.current === readyKey) return
    seenReady.current = readyKey
    if (motion === 'off' || Date.now() - readyAt > 30_000) return
    const workers = Object.values(useFleet.getState().state?.members ?? {})
      .filter((m) => m.leadId === readyLead && (m.status === 'reported' || m.status === 'merged'))
      .sort((a, b) => a.createdAt - b.createdAt).map((m) => m.id)
    return completionMotion(workers, readyLead, card.current)
  }, [readyKey, readyLead, readyAt, motion])

  // A genuinely new item arriving: a brief entrance on the card and one glow across the tray.
  // Keyed on which keys exist, not on the items array (rebuilt on every refresh) and not on which
  // card is in front (Tab cycles that), so a refresh and a cycle both stay still.
  const itemKeys = items.map((i) => i.key).join('\n')
  useEffect(() => {
    const keys = itemKeys ? itemKeys.split('\n') : []
    const before = seenKeys.current
    seenKeys.current = new Set(keys)
    // first pass: whatever is already waiting at load has not just arrived
    if (!before || motion === 'off') return
    const arrived = arrivedKeys(before, keys)
    const front = frontItem()
    if (!front || !arrived.includes(front.key)) return
    const duration = eventDuration(motion)
    const animations = [
      card.current?.animate(
        [
          { opacity: 0.2, transform: `translateY(${motion === 'full' ? 10 : 5}px)` },
          { opacity: 1, transform: 'translateY(0)' }
        ],
        { duration, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }
      ),
      tray.current?.animate(
        [
          { boxShadow: '0 0 0 0 transparent' },
          { boxShadow: `0 0 0 1px var(--accent-line), 0 0 ${motion === 'full' ? 28 : 14}px var(--accent-soft)`, offset: 0.4 },
          { boxShadow: '0 0 0 0 transparent' }
        ],
        { duration: duration + 200, easing: 'ease-out' }
      )
    ].filter((a): a is Animation => !!a)
    return () => animations.forEach((a) => a.cancel())
  }, [itemKeys, motion])
  if (!item) return null
  const n = items.length
  const idx = items.indexOf(item)
  const need = items.filter(blocks).length
  const Icon = iconOf(item)
  const tone = toneOf(item)
  const dot = item.consoleId ? agentColor((allConsoles().find((c) => c.id === item.consoleId)?.data.agentId as string) ?? '') : undefined

  return (
    <div ref={tray} className={`inbox-tray ${floating ? 'floating' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
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
        {!floating && n > 1 && !folded && (
          <button className="btn sm ghost it-all" title="Ctrl+I" onClick={toggleInbox}>
            {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />} {open ? 'Collapse' : 'Show all'}
          </button>
        )}
        <button className="icon-btn sm" title={folded ? 'Unfold the card' : 'Fold the card away'} aria-expanded={!folded} onClick={toggleFolded}>
          {folded ? <ChevronUp size={14} /> : <Minus size={14} />}
        </button>
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

      {!folded && (item.kind === 'approval' || item.kind === 'ask') && (
        <Tip id="inbox">
          Agents stop and ask here. Number keys pick a button, <span className="kbd">Tab</span> moves to the next card, <span className="kbd">Ctrl</span>+<span className="kbd">I</span> lists them all.
        </Tip>
      )}
      {!folded && item.kind === 'ready' && (
        <Tip id="ready">
          The team's work is on its own branch. <b>Merge</b> brings it into your checkout, and nothing is pushed. <b>View diff</b> shows every line first.
        </Tip>
      )}
      <div ref={card} className={`it-card ${folded ? 'folded' : ''}`} key={item.key} data-kind={item.kind}>
        {/* folded, the header is the whole card, so clicking it is the obvious way back */}
        <div className="it-head" onClick={folded ? toggleFolded : undefined}>
          <span className={`it-av ${tone}`}>
            <Icon size={15} />
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="it-title">
              {dot && <span className="agent-dot" style={{ background: dot }} />}
              <b>{item.who}</b> <span className="it-headtext">{headOf(item)}</span>
            </div>
            <div className="it-meta">
              {[item.sub, item.kind === 'ask' ? item.ask && progressOf(item) : '', item.kind === 'ready' ? readyMeta(item) : `${item.kind === 'notice' ? '' : 'waiting '}${ago(item.since)}${item.kind === 'notice' && ago(item.since) !== 'just now' ? ' ago' : ''}`]
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
        {/* not `hidden`: .it-body sets display:flex, which outranks the UA's [hidden] rule, so the
            body would keep its height and fold nothing */}
        {!folded && (
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
        )}
      </div>
    </div>
  )
}

const progressOf = (i: Extract<InboxItem, { kind: 'ask' }>) => i.progress
function readyMeta(i: Extract<InboxItem, { kind: 'ready' }>) {
  const mins = i.lead ? Math.max(1, Math.round((i.ready.at - i.lead.createdAt) / 60000)) : 0
  return [mins ? `${mins < 60 ? `${mins} min` : `${Math.round(mins / 6) / 10} h`}` : '', i.workers ? `${i.workers} worker${i.workers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
}

// What the team was told to do, next to what it actually did. Reaching outside the granted scope
// only ever annotates: a legitimate out-of-scope change is common enough that a gate here would
// teach you to click through it, and then it would be guarding nothing — so Merge stays, and the
// flags are for reading first. A file the user ruled out is the exception: that review is blocked,
// the card drops Merge (inboxModel) and mergeReady refuses it whoever pressed it.
/** 1.2M, 48k, 900 — a size, not an exact count; the point is which member was expensive. */
const tokens = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

/** enough to see the shape of it; the rest is a count, and the diff is a click away */
const MAX_FLAGS = 4

function Review({ review, spend }: { review: MergeReview | null; spend: Record<string, Spent | null> }) {
  if (!review) return null
  const { claims, flags } = review
  if (!claims.length && !flags.length) return null
  const shown = flags.slice(0, MAX_FLAGS)
  const rest = flags.length - shown.length
  return (
    <div className="it-review">
      {claims.map((c, i) => {
        const s = spend[c.cwd]
        const spent = s ? billed(s) : 0
        // the choices it says it made: the part of a report worth reading afterwards
        const decisions = decisionsOf(c.report).slice(0, 3)
        return (
          <Fragment key={i}>
            <div className={`it-claim ${c.reportedAndMerged ? 'ok' : 'warn'}`}>
              {c.reportedAndMerged ? <Check size={12} /> : <TriangleAlert size={12} />}
              <span className="it-claim-who">{c.who}</span>
              <span className="it-claim-what">{c.doneWhen}</span>
              {spent ? <span className="it-claim-spend">{tokens(spent)}</span> : null}
              <span className="it-claim-ev">{c.reportedAndMerged ? 'Merged · agent reported completion' : c.gap}</span>
            </div>
            {decisions.length > 0 && (
              <div className="it-claim-decisions">
                {decisions.map((d, k) => (
                  <div key={k}>{d}</div>
                ))}
              </div>
            )}
          </Fragment>
        )
      })}
      {shown.map((f) => (
        <div key={f.path} className={`it-claim ${f.excluded ? 'danger' : f.outside ? 'warn' : 'risk'}`}>
          {f.excluded ? <Ban size={12} /> : f.outside ? <ArrowUpRight size={12} /> : <ShieldAlert size={12} />}
          <span className="it-claim-what mono">{f.path}</span>
          {/* the exclusion first: the user ruled this file out themselves, and that is why Merge is not on offer */}
          <span className="it-claim-ev it-claim-why">{[f.excluded ? `you ruled out ${f.excluded}` : '', f.outside ? `outside ${claims.length === 1 ? 'its' : 'the team’s'} scope` : '', f.why].filter(Boolean).join(' · ')}</span>
        </div>
      ))}
      {rest > 0 && (
        <div className="it-claim risk">
          <ShieldAlert size={12} />
          <span className="it-claim-what">
            {rest} more file{rest === 1 ? '' : 's'} worth a look
          </span>
        </div>
      )}
    </div>
  )
}

/** What this team is allowed without asking, where you decide whether to allow one more. */
function TeamRules({ lead, rules }: { lead: string; rules: string[] }) {
  return (
    <div className="it-rules">
      <span className="it-meta">Allowed for this team:</span>
      {rules.map((r) => (
        <span key={r} className="it-rule mono" title={r}>
          {r.split('\n')[0]}
          <button className="icon-btn xs" title="Ask about this command again" onClick={() => removeRule(lead, r)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

function Body({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'charter':
      return <CharterCard charter={item.charter} />
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
          {item.team && item.rules.length > 0 && <TeamRules lead={item.team} rules={item.rules} />}
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
          <div className="it-note" role="status">
            <VerifyReady head={r.head} />
            Fleetboard check: {({ passed: 'passed on this commit', failed: 'failed on this commit', stale: 'does not verify this commit (changed commit or worktree)', unobserved: 'no observed verification for this commit' })[verificationOf(r)]}.
            {r.evidence && <details><summary>{r.evidence.command} · exit {r.evidence.run.code ?? 'unavailable'} · {new Date(r.evidence.run.at).toLocaleString()}</summary><code>{r.evidence.run.head}</code><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{r.evidence.run.tail || r.evidence.run.error || 'No output captured.'}</pre></details>}
          </div>
          {item.review?.blocked && <div className="it-note">A file you ruled out is in this diff, so it cannot be merged from here. Read it, tell {item.who} to put the file back, or discard the work.</div>}
          <div className="it-foot">
            {r.verified && (
              <span className="it-verified">
                <span>Agent-reported:</span> {r.verified}
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

function VerifyReady({ head }: { head?: string }) {
  const [busy, setBusy] = useState(false)
  const observing = useFleet((s) => !!s.state?.check?.running)
  const command = useFleet((s) => s.state?.charter?.doneWhen)
  if (!head || !command || !commandLike(command)) return null
  const run = async () => {
    const projectId = useApp.getState().project?.id
    if (!projectId) return
    setBusy(true)
    try { await request('fleet:verifyReady', projectId, head) }
    catch (e) { useApp.getState().toast(errorText(e), 'warn') }
    finally { setBusy(false) }
  }
  return <button className="btn sm" disabled={busy || observing} onClick={run} title={command}>{busy || observing ? 'Checking…' : 'Run completion check'}</button>
}
