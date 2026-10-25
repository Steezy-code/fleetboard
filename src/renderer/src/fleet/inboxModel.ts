import { useEffect } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { request, invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { agentLabel, consoleTail } from '../engine/consoles'
import { useFleet } from '../engine/fleet'
import { approvalFor, commandNote, type Approval } from '@shared/approvals'
import { gateCharter, useCharter } from './charter'
import { addRule, canRule, pruneRules, ruleOf, rulesOf, teamOf, useTeamRules } from './teamRules'
import { awayItem, useAway, useAwayWatcher } from './away'
import { ciItems, fixCi, useCi, type CiItem } from '../workbench/ciStore'
import { agentMade, markSent, routeFeedback, unsent, useFeedback, type PrFeedback } from '../workbench/prFeedback'
import { charterMessage, coerceCharter, FULL_CARD_BELOW, type Charter } from '@shared/charter'
import type { AnswerResult, Prompt, PromptAnswer } from '@shared/prompt'
import type { FleetAsk, FleetMember, FleetReady } from '@shared/fleet'
import { closeOnly, reviewReady, stalled, type MergeReview, type Stall } from '@shared/mergeReview'
import type { Spent } from '@shared/spend'

// The Inbox, as one ordered list: the charter of work that has not started first, then what
// happened while you were away (away.ts), then what blocks an agent (its permission prompts, then the
// Lead's questions), then finished work, then notices (red CI, review comments). The tray on the
// command bar (InboxTray.tsx) shows it; the command bar's keys and voice answer the front item. A
// team member's prompt that one of your team rules covers (teamRules.ts) is answered here and never
// shows.

export interface InboxAction {
  label: string
  /** the button the highlighted / Enter answer runs */
  primary?: boolean
  tone?: 'allow' | 'deny' | 'other'
  run: () => unknown
  /** keeps the item (opens something) instead of answering it */
  keeps?: boolean
}

interface Base {
  key: string
  who: string
  /** "Claude Code", "Lead · CSV export", "PR #9 …" */
  sub: string
  /** first seen, for "waiting 2m" */
  since: number
  actions: InboxAction[]
  /** console to open in focus mode */
  consoleId?: string
  /** typed text goes to this agent (questions, finished work); otherwise to Helm */
  replyTo?: { label: string; send: (text: string) => unknown }
}

export type InboxItem =
  | (Base & { kind: 'charter'; charter: Charter })
  | (Base & { kind: 'approval'; approval: Approval | null; context: string[]; note: string | null; team: string | null; rules: string[] })
  | (Base & { kind: 'ask'; ask: FleetAsk; progress: string })
  | (Base & { kind: 'ready'; ready: FleetReady; lead?: FleetMember; workers: number; review: MergeReview | null; spend: Record<string, Spent | null> })
  | (Base & { kind: 'stopped' })
  | (Base & { kind: 'notice'; tone: 'danger' | 'info'; head: string; lines: string[] })

interface InboxUi {
  items: InboxItem[]
  /** key of the item in front (kept across refreshes) */
  front: string | null
  open: boolean
  /**
   * The card is folded to its one-line header. It stays folded until the user unfolds it, across
   * new items too — someone who folded it away is not asking to be shown the next one in full.
   *
   * ponytail: in memory, so a reload starts unfolded. Keep it in a global (store:setGlobal) only
   * if that turns out to be the wrong default.
   */
  folded: boolean
  /** when the front item came into view: number keys and Enter wait a moment, so a new card is never answered by a key meant for something else */
  shownAt: number
}

export const useInbox = create<InboxUi>(() => ({ items: [], front: null, open: false, folded: false, shownAt: 0 }))

const firstSeen = new Map<string, number>()
const dismissed = new Set<string>()
const seen = (key: string) => {
  if (!firstSeen.has(key)) firstSeen.set(key, Date.now())
  return firstSeen.get(key)!
}

export function frontItem(): InboxItem | null {
  const { items, front } = useInbox.getState()
  return items.find((i) => i.key === front) ?? items[0] ?? null
}

export function frontIndex(): number {
  const { items } = useInbox.getState()
  const f = frontItem()
  return f ? items.indexOf(f) : -1
}

export function setFront(key: string) {
  if (useInbox.getState().front !== key) useInbox.setState({ front: key, shownAt: Date.now() })
}

export function cycleFront(dir: 1 | -1) {
  const { items } = useInbox.getState()
  if (items.length < 2) return
  const i = frontIndex()
  const next = items[(i + dir + items.length) % items.length]
  if (next) setFront(next.key)
}

export const toggleInbox = () => useInbox.setState((s) => ({ open: !s.open }))

/** Fold the card away to its header, or bring it back. Folding also closes the list under it. */
export const toggleFolded = () => useInbox.setState((s) => (s.folded ? { folded: false } : { folded: true, open: false }))

/** A key or Enter can answer the front card only once it has been on screen a moment. */
export const settled = () => Date.now() - useInbox.getState().shownAt > 600

/**
 * Run one of an item's actions. Agents' items leave the tray when their state changes (the prompt is
 * answered, the team is merged); a notice leaves as soon as it is acted on.
 */
export async function runAction(item: InboxItem, i: number) {
  const a = item.actions[i]
  if (!a) return
  if (item.kind === 'notice' && !a.keeps) dismissed.add(item.key)
  await a.run()
  refreshInbox()
}

// ---------------------------------------------------------------- what an approval is about

const CHROME = /[─-▟⠀-⣿]+|[⏺⎿✻✶✳✢·•●○◯◉◐◓◑◒❯›»]+/g

/** The agent's last couple of output lines before its question: what it just did and why it asks. */
export function contextBefore(tail: string, prompt: Prompt | null, n = 2): string[] {
  const lines = tail.split('\n').map((l) => l.replace(CHROME, ' ').replace(/\s+/g, ' ').trim())
  // cut at the prompt: its first line, or the question
  const marks = [prompt?.lines.find((l) => l.trim().length > 3)?.trim(), prompt?.question?.trim()].filter(Boolean) as string[]
  let end = lines.length
  for (const m of marks) {
    const probe = m.replace(CHROME, ' ').replace(/\s+/g, ' ').trim().slice(0, 30)
    const at = lines.findLastIndex((l) => probe && l.includes(probe))
    if (at >= 0) end = Math.min(end, at)
  }
  return lines
    .slice(0, end)
    .filter((l) => l.length > 2 && !/^(esc|ctrl|\?|shift)\b|for shortcuts|to interrupt/i.test(l))
    .slice(-n)
}

// ---------------------------------------------------------------- answers

async function answerPrompt(consoleId: string, a: PromptAnswer) {
  const res = await request('pty:answer', consoleId, a).catch((): AnswerResult => ({ ok: false, reason: 'not-live' }))
  if (res.ok) return useApp.getState().setStatus(consoleId, 'working')
  useApp.getState().toast(res.reason === 'not-live' ? 'That console has stopped' : 'That question changed; nothing was sent. Check the console.', 'warn')
}

/** Consoles a team rule is answering right now: their card stays out of the tray meanwhile. */
const byRule = new Set<string>()
/** console + command already told that its definition files changed: said once, not on every refresh */
const redefinedSaid = new Set<string>()

/** Answer a team member's prompt with the team's rule, if it has one for exactly this command. */
async function answerByRule(id: string, ap: Approval | null) {
  const fleet = useFleet.getState().state
  const lead = teamOf(fleet, id)
  const allow = ap?.options.find((o) => o.tone === 'allow')
  const rule = lead && ap?.command ? ruleOf(lead, ap.command) : undefined
  if (!lead || !ap?.command || !allow || !rule || byRule.has(id)) return
  byRule.add(id)
  const name = fleet?.members[id]?.name ?? 'an agent'
  try {
    const res = await invoke<AnswerResult>('pty:answerByRule', id, allow.answer, ap.command, name, rule.fingerprint).catch((): AnswerResult => ({ ok: false, reason: 'not-live' }))
    if (!res.ok) {
      // the card shows as usual: the question changed, the console is gone, or what the command runs did
      if (res.reason === 'redefined' && !redefinedSaid.has(`${id}\0${ap.command}`)) {
        redefinedSaid.add(`${id}\0${ap.command}`)
        useApp.getState().toast(`What \`${ap.command.split('\n')[0]!.slice(0, 40)}\` runs has changed in ${name}'s folder since you allowed it, so it asks you again`, 'warn')
      }
      return
    }
    useApp.getState().setStatus(id, 'working')
    const cmd = ap.command.split('\n')[0]!
    useApp.getState().toast(`Allowed \`${cmd.length > 40 ? cmd.slice(0, 39) + '…' : cmd}\` for ${name}, by your rule for the team`, 'ok')
  } finally {
    byRule.delete(id)
    refreshInbox()
  }
}

/** "Allow for the team": answer this one, then everyone on the team already waiting on the same command. */
async function allowForTeam(id: string, lead: string, ap: Approval) {
  const allow = ap.options.find((o) => o.tone === 'allow')
  if (!ap.command || !allow) return
  // bound to what the command means where the user said yes; without that, this is a plain Allow
  const fingerprint = await invoke<string | null>('pty:ruleFingerprint', id).catch(() => null)
  if (fingerprint) addRule(lead, ap.command, fingerprint)
  const fleet = useFleet.getState().state
  for (const [other, a] of Object.entries(approvals)) if (other !== id && teamOf(fleet, other) === lead) void answerByRule(other, a.approval)
  return answerPrompt(id, allow.answer)
}

export function openConsole(id: string) {
  const app = useApp.getState()
  const c = allConsoles().find((x) => x.id === id)
  if (!c) return
  if (c.workspaceId !== app.project?.activeWorkspaceId) app.switchWorkspace(c.workspaceId)
  window.setTimeout(() => useApp.getState().enterFocus(id), 80)
}

/**
 * The merge this app made last, while undoing it is still a one-click job. It is dropped after
 * UNDO_WINDOW because a Ready card that never leaves the inbox is just chrome, and by then the
 * answer to "did that merge go in cleanly" is no longer in front of you.
 *
 * ponytail: module state, so it goes when the window reloads — which is the right lifetime for an
 * offer to undo something that happened minutes ago. Persist it only if undo-after-restart is asked
 * for, and then check it is still HEAD before offering (revertMerge already refuses otherwise). It
 * belongs to the project it was made in: opening another project swaps the board without a reload,
 * and that project's Inbox must neither claim the merge nor send its undo to the wrong checkout.
 */
const UNDO_WINDOW = 15 * 60_000
type Merge = { projectId: string; commit: string; into: string; at: number }
let lastMerge: Merge | null = null

async function mergeReady(projectId: string, head: string | undefined) {
  const app = useApp.getState()
  const r = await invoke<{ ok: boolean; into?: string; error?: string; commit?: string }>('fleet:mergeReady', projectId, head)
  if (r.ok) {
    app.toast(r.into ? `Merged into ${r.into}. The team is dismissed.` : 'Done. The team is dismissed.', 'ok')
    lastMerge = r.commit ? { projectId, commit: r.commit, into: r.into ?? '', at: Date.now() } : null
    refreshInbox()
  } else app.toast(`Merge failed: ${r.error}`, 'error')
}

async function undoMerge(m: Merge) {
  const app = useApp.getState()
  if (!(await app.confirm({ title: `Undo the merge into ${m.into}?`, body: 'Adds a commit that reverses everything the team merged. Its branches and worktrees are already gone, so this cannot be re-merged with one click.', confirm: 'Undo the merge', danger: true }))) return
  const r = await invoke<{ ok: boolean; error?: string }>('fleet:revertMerge', m.projectId, m.commit)
  if (r.ok) {
    app.toast(`Reverted. ${m.into} is back where it was.`, 'ok')
    lastMerge = null
    refreshInbox()
  } else app.toast(r.error ?? 'Could not undo the merge', 'error')
}

/**
 * What each member's worktree cost, fetched once per Ready card and then read straight out of here
 * by build(). Only Claude Code files its logs per cwd, so members on other CLIs stay absent and
 * their row simply shows no figure (see spentIn in main/usage.ts).
 */
let spend: Record<string, Spent | null> = {}
let spendKey = ''

function fetchSpend(key: string, cwds: string[]) {
  if (spendKey === key) return
  spendKey = key
  if (!cwds.length) return
  invoke<Record<string, Spent | null>>('usage:spentIn', cwds).then(
    (r) => {
      // a newer card asked meanwhile: this is the old one's spend
      if (spendKey !== key) return
      spend = r
      refreshInbox()
    },
    () => undefined
  )
}

/**
 * Typed back to the Lead on its Ready card. More work for a team is more work however it is asked
 * for, so this door crosses the gate like a goal typed into the bar: the text becomes a charter, the
 * user sees what it was taken to mean, and only then does the Lead hear it.
 */
async function replyToLead(lead: FleetMember, text: string) {
  const confirmed = await gateCharter(coerceCharter(null, text), lead)
  if (!confirmed) return
  await invoke('fleet:userMessage', lead.id, charterMessage(confirmed, text))
  useApp.getState().toast(`Sent to ${lead.name}`, 'ok')
}

/** Ask a member that has gone quiet for a status, in its own console. */
const nudge = (id: string, who: string) => {
  invoke('fleet:userMessage', id, `${who}, where are you up to? Reply with what is done, what is left, and anything you are stuck on.`)
  useApp.getState().toast(`Asked ${who} for a status`, 'ok')
}

async function openPr(projectId: string, ready: FleetReady) {
  const app = useApp.getState()
  if (!(await app.confirm({ title: 'Push this branch and open a draft PR?', body: `Pushes ${ready.branch} to origin and opens a draft pull request with the team's summary as its description.`, confirm: 'Open draft PR' }))) return
  const r = await invoke<{ ok: boolean; url?: string; error?: string }>('fleet:openPr', projectId)
  if (r.ok) {
    app.toast('Draft PR opened', 'ok')
    if (r.url) invoke('shell:openExternal', r.url)
  } else app.toast(r.error ?? 'Could not open the PR', 'error')
}

export async function discardTeam(projectId: string, leadId?: string) {
  const app = useApp.getState()
  if (!(await app.confirm({ title: 'Discard the team’s work?', body: 'Deletes the team’s branches and worktrees and closes its consoles.', confirm: 'Discard', danger: true }))) return
  await invoke('fleet:discard', projectId, leadId)
}

// ---------------------------------------------------------------- the charter nothing has started on

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const noStop = (s: string) => s.trim().replace(/[.,;]+$/, '')

/**
 * Which of the charter's two renderings this one gets. An exclusion always opens the full card,
 * whatever the charter scores: it is the one thing on it that refuses a merge later, and the
 * one-line form has nowhere to show it, so a confident charter would otherwise be agreed to with a
 * rule on it the user never saw. Otherwise low confidence opens the card — but only where there is
 * something to open it on. A one-line message ("tell Kaz it's Windows-only") coerces to a charter
 * with no assumptions, no exclusions and no question, and a card of empty headings says less than
 * the line itself does. `understood` and `doneWhen` both show in the one-line form, so neither is
 * ever the reason to unfold it.
 */
export const fullCard = (c: Charter) => c.wontTouch.length > 0 || (c.confidence < FULL_CARD_BELOW && (c.assumptions.length > 0 || !!c.question))

/**
 * Answering the charter's one question. The answer joins what the job is understood to be — that is
 * the line the Lead is briefed from, so an answer kept anywhere else would not reach it — and the
 * question goes, which also lifts the cap it put on confidence. It starts nothing: the card is still
 * up, now saying what it will do.
 *
 * Appended as a clause rather than a sentence of its own: an option is written as an answer ("by page
 * range"), and few of them read as a sentence after a full stop.
 */
const answerQuestion = (c: Charter, option: string) => useCharter.getState().edit({ understood: `${noStop(c.understood)} — ${noStop(option)}.`, question: undefined, ambiguity: undefined })

/**
 * What confirming this charter will do, after the name on the card. A door that always starts a new
 * team (a playbook) while one is running takes the running team's place — the card is the one screen
 * where that can be said before it happens, so it says it.
 */
export const charterHead = (c: Charter) => (c.followUpTo ? 'gets this next' : c.replaces ? `starts with this, replacing ${c.replaces}’s team` : 'starts with this')

/**
 * The card on the command bar: what the user asked for, as it was understood, before anything runs.
 * Confirm is the primary answer, so Enter in the bar starts it; what the user types there edits
 * `understood` instead of going to Oracle, the way an ask's reply goes to the Lead that asked.
 */
function charterItem(c: Charter, memberName: (id: string) => string): InboxItem {
  const gate = useCharter.getState()
  return {
    kind: 'charter',
    // stable across edits (`at` survives recoercion), so answering the question does not move the card
    key: `charter:${c.at}`,
    who: c.followUpTo ? memberName(c.followUpTo) : 'New team',
    sub: clip(c.request, 90),
    since: c.at,
    charter: c,
    actions: [
      { label: 'Confirm', primary: true, run: () => gate.confirm() },
      ...(c.question?.options ?? []).map((o) => ({ label: o, keeps: true, run: () => answerQuestion(c, o) })),
      { label: 'Dismiss', tone: 'deny' as const, run: () => gate.dismiss() }
    ],
    replyTo: { label: 'the charter', send: (text: string) => gate.edit({ understood: text }) }
  }
}

/** A charter already brought to the front, so Tabbing away from that one card sticks. */
let fronted = ''

// ---------------------------------------------------------------- building the list

let approvals: Record<string, { approval: Approval | null; context: string[] }> = {}
let refreshTimer = 0

export function refreshInbox() {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(build, 0)
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function build() {
  const app = useApp.getState()
  const project = app.project
  if (!project) return useInbox.setState({ items: [], front: null })
  // only this project's team: a state still about the one just left would pair its Lead and Ready
  // card with this project's id on every button
  const mirrored = useFleet.getState().state
  const fleet = mirrored && mirrored.projectId === project.id ? mirrored : null
  const consoles = Object.fromEntries(allConsoles().map((c) => [c.id, c]))
  const items: InboxItem[] = []
  const memberName = (id: string) => fleet?.members[id]?.name ?? (consoles[id]?.data.name as string) ?? 'Lead'

  // 0. work that has not started: nothing blocks the user harder
  const charter = useCharter.getState().pending
  if (charter) items.push(charterItem(charter, memberName))

  // 0b. what happened while you were away, on top until you have read it
  const away = awayItem()
  if (away && !dismissed.has(away.key)) items.push(away)

  // 1. permission prompts and other questions a console is stuck on
  for (const id of Object.keys(app.statuses).filter((id) => app.statuses[id] === 'needs-you' && app.live[id])) {
    const c = consoles[id]
    const ap = approvals[id]
    const key = `approval:${id}`
    const team = teamOf(fleet, id)
    const rules = rulesOf(team).map((r) => r.command)
    // a rule is answering it, or may be about to once its question has been read: no card to flash up
    if (byRule.has(id) || (rules.length && !ap)) continue
    const actions: InboxAction[] = ap?.approval
      ? ap.approval.options.map((o, i) => ({ label: o.label, tone: o.tone === 'always' ? 'other' : o.tone, primary: i === 0 && o.tone === 'allow', run: () => answerPrompt(id, o.answer) }))
      : [{ label: 'Open console', primary: true, keeps: true, run: () => openConsole(id) }]
    const approval = ap?.approval
    if (team && approval && canRule(fleet, id, approval.command) && approval.options.some((o) => o.tone === 'allow')) {
      // next to the one-off yes, of which it is the bigger version
      const at = actions.findIndex((a) => a.tone === 'allow') + 1
      actions.splice(at, 0, { label: 'Allow for the team', tone: 'other', run: () => allowForTeam(id, team, approval) })
    }
    items.push({
      kind: 'approval',
      key,
      who: (c?.data.name as string) ?? 'Agent',
      sub: agentLabel(c?.data.agentId ?? ''),
      since: seen(key),
      consoleId: id,
      approval: approval ?? null,
      context: ap?.context ?? [],
      note: commandNote(approval?.command ?? approval?.detail?.split('\n')[0]),
      team,
      rules,
      actions
    })
  }

  // 2. the Lead's questions
  for (const a of fleet?.asks.filter((x) => !x.answer) ?? []) {
    const key = `ask:${a.id}`
    const lead = fleet?.members[a.from]
    const done = fleet?.tasks.filter((t) => t.status === 'done').length ?? 0
    const total = fleet?.tasks.length ?? 0
    const send = (text: string) => invoke('fleet:answer', a.id, text)
    items.push({
      kind: 'ask',
      key,
      who: memberName(a.from),
      sub: `Lead${lead?.task ? ` · ${lead.task.slice(0, 40)}` : ''}`,
      since: seen(key),
      consoleId: a.from,
      ask: a,
      progress: total ? `${done} of ${total} tasks done` : '',
      actions: a.options.map((o, i) => ({ label: o, primary: a.recommended != null ? i === a.recommended : i === 0, run: () => send(o) })),
      replyTo: { label: memberName(a.from), send }
    })
  }

  // 3. a lead that stopped mid-task
  for (const m of Object.values(fleet?.members ?? {}).filter((m) => m.role === 'lead' && (m.status === 'working' || m.status === 'starting') && app.statuses[m.id] === 'exited')) {
    const key = `stopped:${m.id}`
    items.push({
      kind: 'stopped',
      key,
      who: m.name,
      sub: 'Lead',
      since: seen(key),
      consoleId: m.id,
      actions: [
        { label: 'Open console', primary: true, keeps: true, run: () => openConsole(m.id) },
        { label: 'Discard team', tone: 'deny', run: () => discardTeam(project.id, m.id) }
      ]
    })
  }

  // 4. finished work
  const ready = fleet?.ready
  if (ready) {
    const key = `ready:${ready.leadId}:${ready.at}`
    const lead = fleet?.members[ready.leadId]
    const workers = Object.values(fleet?.members ?? {}).filter((m) => m.leadId === ready.leadId && m.role === 'worker').length
    const review = fleet ? reviewReady(fleet) : null
    fetchSpend(key, review?.claims.map((c) => c.cwd) ?? [])
    // the diff touches a file the charter ruled out: the card offers no Merge at all, as fleet_merge
    // refuses the same work on the Lead's side. Reading the diff is what is left to do.
    const blocked = !!review?.blocked
    const actions: InboxAction[] = closeOnly(ready)
      ? [{ label: 'Done', primary: true, run: () => invoke('fleet:done', project.id) }]
      : blocked
        ? []
        : [{ label: 'Merge', primary: true, run: () => mergeReady(project.id, ready.head) }]
    // a blocked review keeps this on purpose: pushing is not merging, and a draft PR is how a person
    // other than the user gets to see the file that was ruled out
    if (ready.branch && ready.commits > 0 && ready.hasRemote && !ready.prUrl) actions.push({ label: 'Open draft PR', keeps: true, run: () => openPr(project.id, ready) })
    // primary only where Merge was taken away; with nothing to merge, Done is already the primary
    if (ready.branch && ready.commits > 0) actions.push({ label: 'View diff', primary: blocked && !closeOnly(ready), keeps: true, run: () => app.openPanel('fleetDiff', { projectId: project.id }) })
    if (ready.prUrl) actions.push({ label: 'Open PR', keeps: true, run: () => invoke('shell:openExternal', ready.prUrl) })
    actions.push({ label: 'Discard', tone: 'deny', run: () => discardTeam(project.id) })
    items.push({
      kind: 'ready',
      key,
      who: lead?.name ?? 'Lead',
      sub: `Lead${lead?.task ? ` · ${lead.task.slice(0, 40)}` : ''}`,
      since: ready.at,
      consoleId: ready.leadId,
      ready,
      lead,
      workers,
      review,
      spend,
      actions,
      replyTo: lead ? { label: lead.name, send: (text: string) => replyToLead(lead, text) } : undefined
    })
  }

  // 5. notices: red CI, review comments nobody sent to an agent yet
  const ci = useCi.getState().status
  for (const item of ciItems(ci).filter((i) => i.state === 'failing')) {
    const key = `ci:${item.key}:${item.rev}`
    if (dismissed.has(key)) continue
    const failing = item.pr?.checks.filter((c) => c.state === 'failing').map((c) => c.name) ?? []
    items.push(ciNotice(key, item, failing))
  }
  // members that have gone quiet: silence, not the estimate, so this works on a fresh repo too
  for (const x of fleet ? stalled(fleet, Date.now()) : []) {
    const key = `stalled:${x.consoleId}`
    if (dismissed.has(key)) continue
    items.push(stalledNotice(key, x))
  }

  // the merge that just happened, while undoing it is still one click
  if (lastMerge && lastMerge.projectId === project.id && Date.now() - lastMerge.at < UNDO_WINDOW) {
    const m = lastMerge
    const key = `merged:${m.commit}`
    if (!dismissed.has(key)) items.push(mergedNotice(key, m))
  }

  const fb = useFeedback.getState().result
  for (const pr of fb?.ok ? fb.prs : []) {
    const fresh = unsent(pr)
    if (!fresh.length || agentMade(pr)) continue
    const key = `review:${pr.number}:${fresh.map((c) => c.id).join(',')}`
    if (dismissed.has(key)) continue
    items.push(reviewNotice(key, pr, fresh.length))
  }

  const list = items
  const { front, items: before } = useInbox.getState()
  // The gate is the one card that cannot be missed, so a charter new to the list takes the front and
  // unfolds the tray: Enter in the bar answers it, and the check it will run is on screen before it
  // is agreed to. Only a charter not yet fronted does this, so Tabbing away from it sticks.
  const arrived = list.find((i) => i.kind === 'charter' && i.key !== fronted)
  if (arrived) fronted = arrived.key
  // after the gate, the card for coming back is the one thing that takes the front from what was
  // already there: it is what you came back to, and it is only ever there right as you do
  const welcome = !arrived && away && !dismissed.has(away.key) && !before.some((i) => i.key === away.key) ? away.key : null
  const keepFront = !arrived && !welcome && list.some((i) => i.key === front)
  useInbox.setState({
    items: list,
    front: arrived?.key ?? welcome ?? (keepFront ? front : (list[0]?.key ?? null)),
    ...(keepFront ? {} : { shownAt: Date.now() }),
    ...(arrived ? { folded: false } : {})
  })
}

function ciNotice(key: string, item: CiItem, failing: string[]): InboxItem {
  const lines = failing.length ? [`failing: ${failing.join(', ')}`] : item.run ? [`${item.run.title}`] : []
  return {
    kind: 'notice',
    tone: 'danger',
    key,
    who: 'CI',
    sub: item.pr ? `PR #${item.pr.number} ${item.pr.title}` : `${item.run?.workflow} on ${item.branch}`,
    head: 'checks failed',
    lines,
    since: item.run ? Date.parse(item.run.createdAt) || seen(key) : seen(key),
    actions: [
      { label: 'Fix it', primary: true, run: () => fixCi(item) },
      { label: 'Details', keeps: true, run: () => useApp.getState().openDrawer('ci') },
      { label: 'Dismiss', tone: 'deny', run: () => undefined }
    ]
  }
}

function stalledNotice(key: string, x: Stall): InboxItem {
  const h = Math.floor(x.minutes / 60)
  return {
    kind: 'notice',
    tone: 'info',
    key,
    who: x.who,
    sub: 'Working',
    head: `has been silent for ${h ? `${h} h ${x.minutes % 60} min` : `${x.minutes} min`}`,
    lines: ['Its console has printed nothing in that time and it has not reported. It may be waiting on something it cannot ask you about, or stuck.'],
    since: seen(key),
    actions: [
      { label: 'Ask for a status', primary: true, run: () => nudge(x.consoleId, x.who) },
      { label: 'Open its console', keeps: true, run: () => openConsole(x.consoleId) },
      { label: 'Dismiss', tone: 'deny', run: () => undefined }
    ]
  }
}

function mergedNotice(key: string, m: Merge): InboxItem {
  return {
    kind: 'notice',
    tone: 'info',
    key,
    who: 'Fleetboard',
    sub: m.commit.slice(0, 8),
    head: `merged the team's work into ${m.into || 'your checkout'}`,
    lines: ['Nothing is pushed. If it turns out wrong, undoing it now is one commit.'],
    since: seen(key),
    actions: [
      { label: 'Looks right', primary: true, run: () => undefined },
      { label: 'Undo the merge', tone: 'deny', run: () => undoMerge(m) }
    ]
  }
}

function reviewNotice(key: string, pr: PrFeedback, n: number): InboxItem {
  const fresh = unsent(pr)
  return {
    kind: 'notice',
    tone: 'info',
    key,
    who: fresh[0]?.author ? `@${fresh[0].author}` : 'Review',
    sub: `PR #${pr.number} ${pr.title}`,
    head: `left ${plural(n, 'review comment')}`,
    lines: fresh.slice(-2).map((c) => `${c.kind === 'inline' && c.path ? `${c.path.split('/').pop()}${c.line ? `:${c.line}` : ''} · ` : ''}${c.body.replace(/\s+/g, ' ').slice(0, 140)}`),
    since: Date.parse(fresh[0]?.createdAt ?? '') || seen(key),
    actions: [
      { label: 'Send to an agent', primary: true, run: () => routeFeedback(pr) },
      { label: 'Mark handled', run: () => markSent(pr, fresh) },
      { label: 'Open PR', keeps: true, run: () => invoke('shell:openExternal', pr.url) }
    ]
  }
}

/** Mounted once: keeps the list current, and reads each blocked console's question and recent output. */
export function useInboxWatcher() {
  const projectId = useApp((s) => s.project?.id)
  const blocked = useApp(useShallow((s) => Object.keys(s.statuses).filter((id) => s.statuses[id] === 'needs-you' && s.live[id])))
  const sig = useApp(useShallow((s) => [Object.keys(s.statuses).filter((id) => s.statuses[id] === 'exited').join(','), allConsoles().length]))
  const fleet = useFleet((s) => s.state)
  const ci = useCi((s) => s.status)
  const fb = useFeedback((s) => s.result)
  const sent = useApp((s) => s.project?.extras.prSent)
  const charter = useCharter((s) => s.pending)
  const rules = useTeamRules((s) => s.rules)
  const away = useAway((s) => s.summary)
  useAwayWatcher()

  useEffect(() => pruneRules(fleet), [fleet])
  useEffect(refreshInbox, [projectId, blocked.join(','), sig.join('|'), fleet, ci, fb, sent, charter, rules, away])

  useEffect(() => {
    if (!blocked.length) {
      approvals = {}
      return
    }
    let live = true
    const since = Date.now()
    let t = 0
    const read = async () => {
      const entries = await Promise.all(
        blocked.map(async (id) => {
          const [p, tail] = await Promise.all([request('pty:prompt', id).catch(() => null), consoleTail(id, 2500).catch(() => '')])
          return [id, { approval: approvalFor(p), context: contextBefore(tail, p) }] as const
        })
      )
      if (!live) return
      approvals = Object.fromEntries(entries)
      for (const [id, a] of entries) void answerByRule(id, a.approval)
      refreshInbox()
      // a CLI's hook can say it is asking a moment before it draws the question: look again soon
      const pending = entries.some(([, a]) => !a.approval) && Date.now() - since < 5000
      t = window.setTimeout(read, pending ? 250 : 1500)
    }
    read()
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [blocked.join(',')])

  // "waiting 2m" ticks, and silence: a team gone quiet changes nothing that would rebuild the list
  useEffect(() => {
    const t = window.setInterval(refreshInbox, 30_000)
    return () => window.clearInterval(t)
  }, [])
}

export const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
