import { create } from 'zustand'
import { invoke } from '../lib/api'
import { allConsoles, useApp } from '../state/store'
import { isLive, sendToConsole, spawnConsoles } from '../engine/consoles'
import { useFleet } from '../engine/fleet'
import { useCi } from './ciStore'
import type { PrComment, PrFeedback, PrFeedbackResult } from '../../../main/ci'

export type { PrComment, PrFeedback, PrFeedbackResult } from '../../../main/ci'

// PR review-comment watcher: reads reviewers' comments on open PRs every couple of minutes, says when
// new ones arrive, and sends them to the agent that made the PR (its live Lead or console), or to a new
// console working in that branch.
//
// Project extras: prSeen (comment ids already announced), prSent (ids already given to an agent),
// prAgents (branch -> console id that works on it), prAutoRoute (false turns the auto-send off).

export const useFeedback = create<{ result: PrFeedbackResult | null }>(() => ({ result: null }))

const KEEP = 1000
const extras = () => useApp.getState().project?.extras ?? {}
const ids = (key: string): string[] => (Array.isArray(extras()[key]) ? extras()[key] : [])
const remember = (key: string, add: string[]) => useApp.getState().setProjectExtra(key, [...new Set([...ids(key), ...add])].slice(-KEEP))

export const autoRouteOn = () => extras().prAutoRoute !== false
export const setAutoRoute = (on: boolean) => useApp.getState().setProjectExtra('prAutoRoute', on ? undefined : false)

/**
 * Whose review comments may be handed to an agent on their own.
 *
 * A comment routed automatically becomes instructions for a CLI running in the user's checkout. On a
 * public repository anyone can leave one, so without this anyone could tell that agent what to do —
 * and if the console was started with auto-approval, the agent would act on it without asking.
 * GitHub's authorAssociation is the right signal: these three mean the author has write access, or
 * is the repository's owner.
 *
 * Everything else — CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN, or an association GitHub
 * did not give us — still raises a notice with "Send to…" and "Mark handled" in the CI drawer. It is
 * read by a person first, which is the whole difference.
 */
const WRITE_ACCESS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export function trustedAuthor(c: PrComment, viewer?: string): boolean {
  if (viewer && c.author && c.author.toLowerCase() === viewer.toLowerCase()) return true
  return WRITE_ACCESS.has(String(c.association ?? '').toUpperCase())
}

/** A console that answers its own permission prompts must never be fed a comment automatically. */
export function autoApproves(consoleId: string): boolean {
  const node = allConsoles().find((c) => c.id === consoleId)
  if (!node) return false
  return (node.data.autoApprove as boolean | undefined) ?? useApp.getState().settings.autoApprove
}

/** Comments no agent has been given yet. */
export function unsent(pr: PrFeedback): PrComment[] {
  const sent = new Set(ids('prSent'))
  return pr.comments.filter((c) => !sent.has(c.id))
}

export function markSent(pr: PrFeedback, list: PrComment[] = pr.comments) {
  remember('prSent', list.map((c) => c.id))
}

/** A pull request as far as who works on it goes: its branch, and whether it comes from a fork. */
type PrRef = { branch: string; fork: boolean }

/**
 * Who works on this PR's branch now: a console we gave it to, or the live Lead whose branch it is.
 * Never for a fork's PR: anyone can name a branch like one of ours, and what they write would reach
 * our agent as if it were about its own work.
 */
export function ownerOf({ branch, fork }: PrRef): { id: string; name: string; lead: boolean } | null {
  if (fork) return null
  const mine = (extras().prAgents ?? {})[branch] as string | undefined
  const nameOf = (id: string) => (allConsoles().find((c) => c.id === id)?.data.name as string) ?? 'its agent'
  if (mine && isLive(mine)) return { id: mine, name: nameOf(mine), lead: false }
  const lead = Object.values(useFleet.getState().state?.members ?? {}).find((m) => m.role === 'lead' && m.branch === branch && m.status !== 'closed' && isLive(m.id))
  if (lead) return { id: lead.id, name: lead.name, lead: true }
  return null
}

/** Did an agent of ours make this PR? (a team branch, or one we already sent an agent to; never a fork's) */
export function agentMade({ branch, fork }: PrRef): boolean {
  if (fork) return false
  if (branch.startsWith('fleet/')) return true
  if ((extras().prAgents ?? {})[branch]) return true
  return Object.values(useFleet.getState().state?.members ?? {}).some((m) => m.branch === branch)
}

export function setBranchAgent(branch: string, consoleId: string) {
  useApp.getState().setProjectExtra('prAgents', { ...extras().prAgents, [branch]: consoleId })
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function feedbackMessage(pr: PrFeedback, list: PrComment[]): string {
  let budget = 9000
  const items: string[] = []
  list.forEach((c, i) => {
    const where =
      c.kind === 'inline'
        ? ` on ${c.path}${c.line ? ` line ${c.line}` : ''}`
        : c.kind === 'review'
          ? `, review${c.state === 'CHANGES_REQUESTED' ? ' (changes requested)' : c.state === 'APPROVED' ? ' (approved)' : ''}`
          : ''
    const item = `${i + 1}. @${c.author}${where}:\n${clip(c.body, 1500)
      .split('\n')
      .map((l) => '   ' + l)
      .join('\n')}`
    if (budget - item.length < 0) return
    budget -= item.length
    items.push(item)
  })
  const cut = list.length - items.length
  return [
    `New review feedback on PR #${pr.number} "${pr.title}" (${pr.url}), branch ${pr.branch}:`,
    items.join('\n') + (cut ? `\n(+${cut} more on the PR: gh pr view ${pr.number} --comments)` : ''),
    `Address each point on branch ${pr.branch} and push. Then reply on the PR to each comment you handled (gh pr comment ${pr.number}, or gh api for replies to inline comments), starting every reply with 🤖 so it isn't sent back to you. If you disagree with a point, explain why in the reply instead of changing the code.`
  ].join('\n\n')
}

/**
 * Give a PR's feedback to the agent on it: its live Lead or console, else a new console that works in
 * the branch (its own worktree when the branch isn't checked out here). Returns the console id.
 */
export async function routeFeedback(pr: PrFeedback, opts: { list?: PrComment[]; auto?: boolean } = {}): Promise<string | null> {
  const app = useApp.getState()
  if (!app.project) return null
  const list = opts.list ?? (unsent(pr).length ? unsent(pr) : pr.comments)
  if (!list.length) return null
  const msg = feedbackMessage(pr, list)
  const owner = ownerOf(pr)
  if (owner && opts.auto && autoApproves(owner.id)) {
    // it would act on these words without asking: tell the user instead, who can still send it by hand
    app.toast(`${list.length} review comment${list.length === 1 ? '' : 's'} on PR #${pr.number}: ${owner.name} approves everything, so they were not sent automatically`, 'warn')
    return null
  }
  if (owner) {
    if (owner.lead) await invoke('fleet:userMessage', owner.id, msg)
    else sendToConsole(owner.id, msg)
    markSent(pr, list)
    app.toast(`Sent ${list.length} review comment${list.length === 1 ? '' : 's'} on PR #${pr.number} to ${owner.name}`, 'info')
    return owner.id
  }
  const current = useCi.getState().status
  const here = current?.ok && current.branch === pr.branch
  const prompt =
    msg +
    '\n\n' +
    (here
      ? 'You are in my checkout, already on that branch.'
      : `Don't touch my current checkout${current?.ok ? ` (it is on ${current.branch})` : ''}: add a git worktree for ${pr.branch} in a temporary folder, work and push from there, then remove the worktree.`)
  const taken = allConsoles().map((c) => c.data.name as string)
  let name = `PR #${pr.number} fixer`
  for (let n = 2; taken.includes(name); n++) name = `PR #${pr.number} fixer ${n}`
  // explicitly not auto-approving: the prompt is built from other people's words, and without this
  // the console would inherit the global auto-approve setting
  const [id] = spawnConsoles({ names: [name], initialPrompt: prompt, autoApprove: false })
  if (!id) return null
  setBranchAgent(pr.branch, id)
  markSent(pr, list)
  app.toast(opts.auto ? `New review comments on PR #${pr.number}, so ${name} is on them` : `${name} is on it`, 'info')
  if (!opts.auto) window.setTimeout(() => useApp.getState().focusItem(id), 120)
  return id
}

/** Take in a fresh result: on the first look at a project everything counts as old; after that, announce and route what's new. */
export function applyFeedback(result: PrFeedbackResult) {
  useFeedback.setState({ result })
  if (!result.ok) return
  const all = result.prs.flatMap((p) => p.comments.map((c) => c.id))
  if (!Array.isArray(extras().prSeen)) {
    remember('prSeen', all)
    remember('prSent', all)
    return
  }
  const seen = new Set(ids('prSeen'))
  const fresh = result.prs.map((pr) => ({ pr, list: pr.comments.filter((c) => !seen.has(c.id)) })).filter((x) => x.list.length)
  if (!fresh.length) return
  remember('prSeen', fresh.flatMap((x) => x.list.map((c) => c.id)))
  for (const { pr, list } of fresh) {
    const who = [...new Set(list.map((c) => '@' + c.author))].join(', ')
    // only people with write access get to instruct an agent without a person reading first
    const trusted = list.filter((c) => trustedAuthor(c, result.viewer))
    const outside = list.filter((c) => !trustedAuthor(c, result.viewer))
    if (autoRouteOn() && agentMade(pr) && trusted.length) {
      const from = [...new Set(trusted.map((c) => '@' + c.author))].join(', ')
      void routeFeedback(pr, { list: trusted, auto: true }).then((id) => id && notifyFeedback(`Review comments on PR #${pr.number}`, `${trusted.length} from ${from}, sent to its agent`, false))
    }
    if (outside.length) {
      const from = [...new Set(outside.map((c) => '@' + c.author))].join(', ')
      notifyFeedback(
        `New review comments on PR #${pr.number}`,
        trusted.length
          ? `${outside.length} more from ${from}, not sent on: no write access to this repo`
          : `${outside.length} from ${from}: ${clip((outside[0]?.body ?? '').replace(/\s+/g, ' '), 90)}`
      )
    } else if (!(autoRouteOn() && agentMade(pr) && trusted.length)) {
      notifyFeedback(`New review comments on PR #${pr.number}`, `${list.length} from ${who}: ${clip((list[0]?.body ?? '').replace(/\s+/g, ' '), 90)}`)
    }
  }
}

function notifyFeedback(title: string, body: string, toast = true) {
  if (toast) useApp.getState().toast(`${title}: ${body}`, 'info')
  if (document.hasFocus() || typeof Notification === 'undefined') return
  try {
    const n = new Notification(title, { body })
    n.onclick = () => {
      window.focus()
      useApp.getState().openDrawer('ci')
    }
  } catch {
    /* notifications unavailable */
  }
}

let inflight: Promise<void> | null = null
export function refreshFeedback(): Promise<void> {
  const path = useCi.getState().path
  if (!path) return Promise.resolve()
  if (inflight) return inflight
  inflight = invoke<PrFeedbackResult>('ci:prFeedback', path)
    .then((r) => {
      if (useCi.getState().path === path) applyFeedback(r)
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
  return inflight
}
