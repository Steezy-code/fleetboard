import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { PtySpawnRequest } from '@shared/types'
import type { FleetAsk, FleetMember, FleetMessage, FleetReady, FleetRole, FleetState, FleetTask } from '@shared/fleet'
import { emptyFleet } from '@shared/fleet'
import type { Charter } from '@shared/charter'
import { charterMessage, coerceCharter } from '@shared/charter'
import { excludedBy } from '@shared/mergeReview'
import { estimateOf, stampTask } from '@shared/live'
import { agentById } from '@shared/agents'
import type { MainContext } from './context'
import { dirs, readJson, writeJsonAtomic } from './paths'
import { logError } from './errors'
import { loginEnv } from './env'
import { ghEnv, run, git as runGit } from './run'
import { append as journal, answered } from './journal'
import { homeOf, linkPath } from './platform'
import { newSecret, refuse, sameSecret } from './localserver'
import { findTask, guessTask } from './plan'
import { geminiTeamHome, geminiTrusts, removeGeminiTeamHome } from './gemini-home'
import { runCheck, startLive, stopCheck, stopLive } from './live'

// Lead/worker teams. Every fleet console is connected to this local MCP server, which gives the lead
// tools to plan, start workers, message them and merge their work, and gives workers a way to report.
// Workers run in their own git worktree branched from the lead's integration branch, so they can't
// step on each other or on the user's checkout. Messages are typed into a console when it goes idle.

const fleetDir = path.join(dirs.root, 'fleet')
const treesDir = path.join(dirs.root, 'worktrees')
fs.mkdirSync(fleetDir, { recursive: true })
fs.mkdirSync(treesDir, { recursive: true })

let ctx: MainContext
let port = 0
/** this run's secret, from which each team console's own bearer token for the MCP server is made */
const secret = newSecret()
/**
 * A member's token: good for that member only. The server takes who is calling from the URL, so one
 * token for all would let any console that reads its own config call as another (a worker as the Lead).
 */
const memberToken = (id: string) => crypto.createHmac('sha256', secret).update(id).digest('base64url')
/** the most a call may send (a report or a plan is a few KB) */
const MAX_BODY = 4 * 1024 * 1024
const states = new Map<string, FleetState>()
/** console id → project id */
const memberProject = new Map<string, string>()
/** lead id → pending fleet_wait resolver */
/** this module's timers, so they can be stopped (see register / stopFleetTicks) */
const ticks: NodeJS.Timeout[] = []
const waiters = new Map<string, (events: FleetMessage[]) => void>()
/** ask id → pending fleet_ask_user resolver */
const askWaiters = new Map<string, (answer: string) => void>()
/** request id → renderer ack for a new console node */
const acks = new Map<string, (v: { name?: string }) => void>()
/** lead id → commit the lead's integration branch started from */
const baseCommit = new Map<string, string>()

const uid = (p: string) => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
const MAX_WORKERS = 4
const TASK_STATUSES: FleetTask['status'][] = ['todo', 'doing', 'review', 'done', 'blocked']
/** CLIs that can be team members: they reach the fleet tools over MCP (see fleetLaunch) */
const TEAM_AGENTS = ['claude', 'codex', 'gemini']
const WAIT_CAP_MS = 170_000

// ---------------------------------------------------------------- state

/**
 * A project id is a hash from store.projectIdFor, and it is used as a file name and as a folder name
 * under ~/.fleetboard/worktrees. It arrives over IPC, and store.ts checks exactly this before using
 * one as a path (`/^[\w-]+$/`) — fleet.ts did not, so `fleet:startLead` with an id of
 * "../../.config/autostart/x" wrote its state outside ~/.fleetboard and created folders there too.
 */
const assertProjectId = (projectId: string) => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error('Bad project id')
  return projectId
}

const stateFile = (projectId: string) => path.join(fleetDir, `${assertProjectId(projectId)}.json`)
/** exported for the test that pins the check above */
export const stateFileFor = stateFile

function loadAll() {
  for (const f of fs.readdirSync(fleetDir)) {
    if (!f.endsWith('.json')) continue
    const s = readJson<FleetState | null>(path.join(fleetDir, f), null)
    if (!s) continue
    states.set(s.projectId, s)
    for (const m of Object.values(s.members)) memberProject.set(m.id, s.projectId)
    for (const m of Object.values(s.members)) if (m.role === 'lead' && (m as any).base) baseCommit.set(m.id, (m as any).base)
  }
}

function state(projectId: string, projectPath = ''): FleetState {
  let s = states.get(projectId)
  if (!s) {
    s = emptyFleet(projectId, projectPath)
    states.set(projectId, s)
  }
  if (projectPath) s.projectPath = projectPath
  return s
}

const saveTimers = new Map<string, NodeJS.Timeout>()
function changed(s: FleetState) {
  clearTimeout(saveTimers.get(s.projectId))
  saveTimers.set(
    s.projectId,
    setTimeout(() => {
      s.messages = s.messages.slice(-300)
      writeJsonAtomic(stateFile(s.projectId), s)
      ctx.emit('fleet:state', s)
    }, 80)
  )
}

const memberOf = (id: string): { s: FleetState; m: FleetMember } | null => {
  const pid = memberProject.get(id)
  const s = pid ? states.get(pid) : undefined
  const m = s?.members[id]
  return s && m ? { s, m } : null
}

function findMember(s: FleetState, ref: string): FleetMember | undefined {
  const r = ref.trim().replace(/^@/, '').toLowerCase()
  const all = Object.values(s.members).filter((m) => m.status !== 'closed')
  return all.find((m) => m.id === ref) ?? all.find((m) => m.name.toLowerCase() === r) ?? all.find((m) => m.name.toLowerCase().replace(/\s+/g, '') === r.replace(/\s+/g, ''))
}

// ---------------------------------------------------------------- git

/**
 * A merge or a worktree add can take a while, hence the long timeout. The hardened environment comes
 * with it now: this module parses --numstat and --stat output, which LC_ALL=C exists to keep stable,
 * and it used to set GIT_TERMINAL_PROMPT alone.
 */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await runGit(cwd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() }
}

const slugify = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['a', 'an', 'the', 'to', 'and', 'of', 'for', 'with', 'please', 'add', 'make'].includes(w))
    .slice(0, 4)
    .join('-') || 'task'

/** Give a worktree the repo's installed dependencies without copying them. */
function linkHeavyDirs(projectPath: string, wt: string) {
  for (const d of ['node_modules', '.venv', 'venv', 'vendor']) {
    const src = path.join(projectPath, d)
    const dst = path.join(wt, d)
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        linkPath(src, dst)
      } catch {
        /* best effort */
      }
    }
  }
}
const ADD_ALL = ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).venv', ':(exclude)venv', ':(exclude)vendor']

async function createWorktree(repoCwd: string, projectPath: string, projectId: string, dirName: string, branch: string) {
  const dir = path.join(treesDir, assertProjectId(projectId), dirName)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const r = await git(repoCwd, ['worktree', 'add', '-b', branch, dir, 'HEAD'])
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err}`)
  linkHeavyDirs(projectPath, dir)
  return dir
}

/** Tell the user about something that put a member's work at risk: the lead is a model, so a note
 *  in its chat is not a report to anyone who can act on it. */
function trouble(s: FleetState, message: string, tone: 'warn' | 'info' = 'warn') {
  if (tone === 'warn') logError('fleet', message)
  ctx.emit('fleet:trouble', { projectId: s.projectId, message, tone })
}

/** Is every commit on `branch` already on `into`? (`git branch -d` asks about HEAD, not the lead.) */
export async function containedIn(projectPath: string, branch?: string, into?: string) {
  if (!branch) return true // nothing of its own to lose
  if (!into) return false
  return (await git(projectPath, ['merge-base', '--is-ancestor', branch, into])).ok
}

/** What keepUncommitted did: there was nothing to keep, it made a rescue commit, or it could not. */
export type Kept = 'clean' | 'rescued' | 'failed'

/**
 * Commit whatever a member never committed, so its worktree can be removed without losing work.
 * 'failed' when there is uncommitted work it could not save — then the worktree stays.
 */
async function keepUncommitted(s: FleetState, m: FleetMember): Promise<Kept> {
  const add = await git(m.cwd, ADD_ALL)
  if (!add.ok) {
    trouble(s, `${m.name}'s changes could not be staged (${add.err.slice(0, 160)}), so its folder is kept at ${m.cwd}.`)
    return 'failed'
  }
  if ((await git(m.cwd, ['diff', '--cached', '--quiet'])).ok) return 'clean' // nothing of its own uncommitted
  if (!m.branch) {
    trouble(s, `${m.name} has uncommitted changes and no branch of its own, so its folder is kept at ${m.cwd}.`)
    return 'failed'
  }
  const r = await git(m.cwd, [
    'commit',
    '-m',
    `Unreported work from ${m.name} (Fleetboard)\n\nCommitted so removing its worktree could not throw it away.\nTask: ${m.task?.slice(0, 500) ?? ''}`
  ])
  if (!r.ok) {
    trouble(s, `${m.name} has uncommitted work that could not be committed (${r.err.slice(0, 160)}), so its folder is kept at ${m.cwd}.`)
    return 'failed'
  }
  trouble(s, `${m.name} had work it never reported; it is kept as a commit on ${m.branch}.`, 'info')
  return 'rescued'
}

/**
 * Whether a member's branch may still be deleted once its worktree is gone.
 *
 * `asked` was decided by the caller, and dismissTeam decides it with containedIn *before* any of this
 * runs — so it can only speak for the commits that existed then. keepUncommitted may put a new commit
 * on the branch a moment later, one the lead's branch cannot possibly contain, right after telling the
 * user the work "is kept as a commit on <branch>". Deleting the branch there made that commit
 * unreachable and the message a lie, so a rescue commit always keeps the branch.
 */
export const branchToDelete = (asked: 'merged' | 'force' | 'keep', kept: Kept): 'merged' | 'force' | 'keep' =>
  kept === 'rescued' ? 'keep' : asked

/**
 * Whether a member's worktree is its own to remove.
 *
 * It must sit inside the worktrees folder — with the separator, so a sibling like `worktrees-old`
 * cannot pass as being inside it — and no other live member may be working in the same folder. A
 * reviewer is given its lead's cwd, so without the second test, dismissing a reviewer removed the
 * lead's worktree.
 */
export function ownWorktree(
  m: { id: string; cwd: string },
  members: { id: string; cwd: string; status: string }[],
  trees: string
): boolean {
  if (!m.cwd.startsWith(trees + path.sep)) return false
  return !members.some((x) => x.id !== m.id && x.status !== 'closed' && x.cwd === m.cwd)
}

/**
 * Remove a member's worktree once nothing of its own would go with it.
 *
 * Two ways this used to lose work. A reviewer runs in its *lead's* worktree (fleet_spawn_reviewer
 * hands it the lead's cwd and no branch), so dismissing a reviewer removed the lead's worktree and
 * everything the lead had not committed. And `worktree remove --force` is precisely what makes git
 * discard uncommitted changes, while a worker's work is only ever committed by fleet_report — so a
 * worker dismissed before it reported lost every edit it had made.
 */
async function removeWorktree(s: FleetState, m: FleetMember, deleteBranch: 'merged' | 'force' | 'keep') {
  const projectPath = s.projectPath
  if (!ownWorktree(m, Object.values(s.members), treesDir)) return
  const kept = await keepUncommitted(s, m)
  if (kept === 'failed') return
  for (const d of ['node_modules', '.venv', 'venv', 'vendor']) {
    const p = path.join(m.cwd, d)
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p)
    } catch {
      /* not there */
    }
  }
  const rm = await git(projectPath, ['worktree', 'remove', '--force', m.cwd])
  if (!rm.ok) return trouble(s, `${m.name}'s folder could not be removed (${rm.err.slice(0, 160)}); it is kept at ${m.cwd}.`)
  const how = branchToDelete(deleteBranch, kept)
  if (m.branch && how !== 'keep') await git(projectPath, ['branch', how === 'force' ? '-D' : '-d', m.branch])
  journal({
    kind: 'fleet.remove',
    text: `${m.name}'s worktree removed${m.branch ? (how === 'keep' ? `, branch ${m.branch} kept` : `, branch ${m.branch} deleted`) : ''}${kept === 'rescued' ? ' (its unreported work was committed first)' : ''}`,
    project: projectPath,
    detail: { member: m.name, branch: m.branch, branchDeleted: how !== 'keep', rescued: kept === 'rescued' }
  })
}

// ---------------------------------------------------------------- prompts

export function leadPrompt(m: FleetMember) {
  return [
    `You are ${m.name}, the Lead of a Fleetboard team. The user gives you goals; you get them done through workers.`,
    'You have fleet tools (mcp__fleet__*). Rules:',
    '1. Never edit files yourself. Read the repo to understand it, then delegate.',
    '2. Break the goal into a short plan with fleet_plan (one line per task, and in estimates the minutes you expect each to take). Keep it small: 1-4 tasks.',
    `3. Start one worker per task with fleet_spawn_worker, passing the plan task's id as task_ref. Give each worker files/folders it owns that no other worker touches, and a done_when check (a command that proves it works). At most ${MAX_WORKERS} workers at once.`,
    '4. After starting workers, call fleet_wait to receive their reports (it returns when something happens). Do not poll or sleep.',
    '5. When a worker reports done, read its summary and fleet_merge it into your integration branch. If it is blocked, help it with fleet_send.',
    '6. Once everything is merged, start one reviewer with fleet_spawn_reviewer to check the combined work against the goal and run the checks. Send any findings to the worker that owns the code (fleet_send), wait, merge again.',
    '7. Ask the user only for real decisions, with fleet_ask_user and 2-4 short options, each with a one-line trade-off in notes and the one you recommend. Make reasonable choices yourself otherwise.',
    '8. Your goal as given, and any assumptions, "Do not touch" or "Done when" that come with it, are what the user confirmed: not yours to reinterpret or widen. If the job looks wrong, ask with fleet_ask_user rather than deciding.',
    '9. When the goal is met and verified, call fleet_finish with a short summary (one change per line) and what you verified. The user then merges your branch with one click.',
    'Keep your own messages short: one-line progress updates.',
    `Your working directory is a git worktree on branch ${m.branch ?? '(none)'} made from the user's current commit; workers branch from it.`
  ].join('\n')
}

function workerPrompt(m: FleetMember, lead?: FleetMember) {
  if (m.role === 'reviewer')
    return [
      `You are ${m.name}, a reviewer on a Fleetboard team led by ${lead?.name ?? 'the lead'}.`,
      'Review only: do not edit any files. Check the work against the goal, run the project checks (tests, typecheck), and look for real bugs, missing edge cases and broken conventions.',
      'Then call fleet_report with status "approve" or "changes" and a short list of concrete issues (file:line, what is wrong, what to do).'
    ].join('\n')
  return [
    `You are ${m.name}, a worker on a Fleetboard team led by ${lead?.name ?? 'the lead'}.`,
    'Do only the task you are given and edit only the files you own. If you need something outside them, ask the lead with fleet_send.',
    'Work in your current directory (your own git worktree). Do not commit or push; Fleetboard commits your work when you report.',
    'When your done_when check passes, call fleet_report with status "done" and a 3-6 line summary (what changed, files, how you verified). If you are stuck, call fleet_report with status "blocked" and what you need.'
  ].join('\n')
}

/** `wontTouch` is what the user ruled out when they confirmed the charter; a worker cannot read the lead's brief to learn it. */
export function briefFor(m: FleetMember, lead?: FleetMember, wontTouch: string[] = []) {
  const parts = [`Task from ${lead?.name ?? 'the lead'}: ${m.task}`]
  if (m.owns?.length) parts.push(`You own: ${m.owns.join(', ')}.`)
  if (wontTouch.length) parts.push(`Do not touch: ${wontTouch.join(', ')}.`)
  if (m.doneWhen) parts.push(`Done when: ${m.doneWhen}.`)
  parts.push(m.role === 'reviewer' ? 'When finished, call fleet_report with your verdict.' : 'When done, call fleet_report.')
  // CLIs without a system-prompt flag get the role rules inline
  if (m.agentId !== 'claude') parts.unshift(workerPrompt(m, lead).replace(/\n/g, ' '))
  return parts.join(' ')
}

// ---------------------------------------------------------------- launch args (used by pty.spawn)

const mcpFile = (id: string) => path.join(dirs.hooks, `mcp-${id}.json`)

/** Extra CLI args/env for a console that belongs to a team. */
export function fleetLaunch(req: PtySpawnRequest, loginEnvFor: Record<string, string | undefined> = process.env): { args: string[]; env: Record<string, string> } | null {
  const found = memberOf(req.id)
  if (!found || !port) return null
  const { m, s } = found
  const url = `http://127.0.0.1:${port}/mcp/${m.id}`
  const env: Record<string, string> = { MCP_TOOL_TIMEOUT: '600000' }
  if (m.agentId === 'claude') {
    writeJsonAtomic(mcpFile(m.id), { mcpServers: { fleet: { type: 'http', url, headers: { Authorization: `Bearer ${memberToken(m.id)}` } } } }, 0o600)
    const lead = m.leadId ? s.members[m.leadId] : undefined
    const args = ['--mcp-config', mcpFile(m.id), '--append-system-prompt', m.role === 'lead' ? leadPrompt(m) : workerPrompt(m, lead)]
    if (m.role === 'worker') args.push('--permission-mode', 'acceptEdits')
    if (m.role === 'reviewer') args.push('--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
    // the fleet tools themselves never need a permission prompt
    args.push('--allowedTools', 'mcp__fleet')
    return { args, env }
  }
  if (m.agentId === 'codex') {
    // the token comes from the environment: command lines are visible to every process on the machine
    const args = ['-c', `mcp_servers.fleet.url="${url}"`, '-c', 'mcp_servers.fleet.bearer_token_env_var="FB_MCP_TOKEN"']
    // the fleet tools never ask the user (Claude Code: --allowedTools mcp__fleet); without this Codex asks
    // "Allow the fleet MCP server to run tool …?" before every report, message and wait
    args.push('-c', 'mcp_servers.fleet.default_tools_approval_mode="approve"')
    env.FB_MCP_TOKEN = memberToken(m.id)
    // edits in its worktree without asking, commands sandboxed (what --full-auto was before Codex dropped it)
    if (m.role === 'worker') args.push(...(agentById('codex')?.editsArgs ?? []))
    return { args, env }
  }
  if (m.agentId === 'gemini') {
    // Gemini takes MCP servers only from settings: a home of its own with the fleet server added
    env.GEMINI_CLI_HOME = geminiTeamHome(m.id, { url, token: memberToken(m.id) }, loginEnvFor)
    const args: string[] = []
    if (m.role === 'worker') args.push(...(agentById('gemini')?.editsArgs ?? []))
    // its worktree is a new folder: trusted for this session when the user trusts the project itself
    if (m.cwd.startsWith(treesDir) && geminiTrusts(s.projectPath, loginEnvFor)) args.push('--skip-trust')
    return { args, env }
  }
  return { args: [], env }
}

/** Whether a console belongs to a team (its launch arguments come from fleetLaunch). */
export const isTeamConsole = (id: string) => !!memberOf(id)

// ---------------------------------------------------------------- messaging

function post(s: FleetState, msg: Omit<FleetMessage, 'id' | 'at' | 'delivered'>) {
  const full: FleetMessage = { ...msg, id: uid('msg'), at: Date.now(), delivered: false }
  s.messages.push(full)
  ctx.emit('fleet:traffic', { from: msg.from, to: msg.to, kind: msg.kind })
  const w = waiters.get(msg.to)
  if (w) {
    waiters.delete(msg.to)
    full.delivered = true
    w([full])
  }
  changed(s)
  return full
}

const labelOf = (s: FleetState, id: string) => (id === 'user' ? 'the user' : s.members[id]?.name ?? id)

function render(s: FleetState, msg: FleetMessage) {
  switch (msg.kind) {
    case 'goal':
      return msg.text
    case 'report':
      return `[Fleet] ${labelOf(s, msg.from)} reported: ${msg.text}`
    case 'answer':
      return `[Fleet] ${msg.text}`
    case 'message':
      return `[Fleet] Message from ${labelOf(s, msg.from)}: ${msg.text}`
    default:
      return msg.text
  }
}

// ---------------------------------------------------------------- folder trust

/**
 * Claude Code's global config, where it records trusted folders: ~/.claude.json, or .claude.json in
 * CLAUDE_CONFIG_DIR when the user's environment sets one (team consoles start with that environment).
 */
let claudeConfigFile = ''
async function findClaudeConfig() {
  const env = await loginEnv()
  claudeConfigFile = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homeOf(env), '.claude.json')
}

/** Is this folder (or a parent) trusted in the user's Claude Code config? Read-only. */
let trustCache: { at: number; dirs: string[] } = { at: 0, dirs: [] }
function claudeTrusts(dir: string) {
  if (!claudeConfigFile) return false
  if (Date.now() - trustCache.at > 30_000) {
    const cfg = readJson<any>(claudeConfigFile, {})
    trustCache = {
      at: Date.now(),
      dirs: Object.entries(cfg?.projects ?? {})
        .filter(([, v]: [string, any]) => v?.hasTrustDialogAccepted)
        .map(([k]) => k.replace(/\/+$/, ''))
    }
  }
  const d = path.resolve(dir)
  return trustCache.dirs.some((t) => d === t || d.startsWith(t + path.sep))
}

/**
 * Team worktrees are copies of the user's repo, so they inherit its trust: when Claude asks
 * "Do you trust this folder?" for one and the user already trusts the source repo, answer yes.
 * Otherwise the prompt stays in the user's Inbox.
 */
function trustTick() {
  for (const s of states.values()) {
    if (!claudeTrusts(s.projectPath)) continue
    for (const m of Object.values(s.members)) {
      if (m.status === 'closed' || m.agentId !== 'claude' || !m.cwd.startsWith(treesDir)) continue
      if (ctx.ptys.status(m.id) !== 'needs-you' || trustAnswered.has(m.id)) continue
      const trust = ctx.ptys.screen(m.id)?.prompt?.options?.find((o) => /^yes, i trust this folder$/i.test(o.label))
      if (!trust) continue
      trustAnswered.add(m.id)
      void ctx.ptys.answer(m.id, { option: trust.label }).then((r) => {
        if (r.ok) answered(`Fleetboard, trusting the folder for ${m.name}`, m.id, trust.label)
        if (!r.ok) trustAnswered.delete(m.id)
      })
    }
  }
}
const trustAnswered = new Set<string>()

/** Type queued messages into consoles that are idle. */
function deliverTick() {
  for (const s of states.values()) {
    for (const msg of s.messages) {
      if (msg.delivered || msg.to === 'user') continue
      if (waiters.has(msg.to)) continue
      if (!ctx.ptys.readyForInput(msg.to)) continue
      msg.delivered = true
      const text = render(s, msg).replace(/\s*\n\s*/g, ' ').trim()
      ctx.ptys.typeAndSubmit(msg.to, text)
      changed(s)
      break // one message per tick per project, so the CLI sees them one at a time
    }
  }
}

// ---------------------------------------------------------------- consoles

/** Ask the board to add a node for a new team console, then start its process. */
async function startConsole(s: FleetState, m: FleetMember, extra: { acceptEdits?: boolean } = {}) {
  // before the board can mount the node and start it: this is a first start, not a restart
  startedThisRun.add(m.id)
  const reqId = uid('req')
  const named = await new Promise<{ name?: string }>((resolve) => {
    acks.set(reqId, resolve)
    ctx.emit('fleet:addConsole', { reqId, member: m })
    setTimeout(() => acks.has(reqId) && (acks.delete(reqId), resolve({})), 4000)
  })
  if (named.name && named.name !== m.name) {
    m.name = named.name
    changed(s)
  }
  void extra // role permissions come from fleetLaunch
  await ctx.ptys.spawn({ id: m.id, agentId: m.agentId, cwd: m.cwd, cols: 100, rows: 30 })
}

function pickName(s: FleetState, wanted?: string) {
  const used = new Set(Object.values(s.members).filter((m) => m.status !== 'closed').map((m) => m.name.toLowerCase()))
  if (wanted && !used.has(wanted.toLowerCase())) return wanted
  for (let round = 1; round < 9; round++)
    for (const n of ctx.settings().names) {
      const name = round === 1 ? n : `${n} ${round}`
      if (!used.has(name.toLowerCase())) return name
    }
  return `Worker ${used.size + 1}`
}

/** What the Lead is first told: the agreed charter, with the goal after it where that is more than the request (see charterMessage), otherwise the goal as given. */
export const goalMessageFor = (charter: Charter | undefined, goal: string) => (charter ? charterMessage(charter, goal) : goal)

/**
 * A charter off the wire, through coercion again. It arrives from the renderer like every other
 * `fleet:startLead` argument and is trusted no further than `projectId` is (see assertProjectId): an
 * `understood` that is not a string would otherwise throw where the goal is composed, after the
 * worktree and the console already exist, and a `wontTouch` that is a string has a length and would
 * throw inside the merge gate it is supposed to be guarding. The charter's own `request` is kept —
 * it is what tells charterMessage whether `goal` says anything the brief does not.
 */
export const trustedCharter = (charter: Charter | undefined, goal: string): Charter | undefined => {
  if (!charter) return undefined
  const request = typeof charter.request === 'string' && charter.request.trim() ? charter.request : goal
  return coerceCharter(charter, request)
}

/** What a Lead is told when its console comes back. A restored conversation still has its goal, so it is not repeated. */
export function leadRestartNote(o: { how: string; team: string; task: string; charter: Charter | undefined; resume: boolean }) {
  const goal = o.resume ? '' : ` Your goal: ${goalMessageFor(o.charter, o.task)}`
  return `[Fleet] ${o.how}${goal} Team: ${o.team}. Merge any finished work that is not merged yet, call fleet_wait for reports, then carry on.`
}

export async function startLead(opts: { projectId: string; projectPath: string; goal: string; agentId?: string; /** short display name (playbooks pass one; the goal is the full brief) */ title?: string; /** what the user agreed the job is; without one the Lead is given `goal` as typed */ charter?: Charter }): Promise<FleetMember> {
  const s = state(opts.projectId, opts.projectPath)
  const id = uid('con')
  const agentId = opts.agentId ?? 'claude'
  const charter = trustedCharter(opts.charter, opts.goal)
  const title = (opts.title ?? opts.goal).trim()
  const slug = `${slugify(title)}-${id.slice(-4)}`
  let cwd = opts.projectPath
  let branch: string | undefined
  const isRepo = (await git(opts.projectPath, ['rev-parse', '--verify', 'HEAD'])).ok
  if (isRepo) {
    branch = `fleet/${slug}`
    cwd = await createWorktree(opts.projectPath, opts.projectPath, opts.projectId, `${slug}-lead`, branch)
    const base = (await git(cwd, ['rev-parse', 'HEAD'])).out
    baseCommit.set(id, base)
  }
  const leads = Object.values(s.members).filter((m) => m.role === 'lead' && m.status !== 'closed').length
  const m: FleetMember = {
    id,
    role: 'lead',
    name: leads ? `Lead ${leads + 1}` : 'Lead',
    agentId,
    projectId: opts.projectId,
    task: title,
    cwd,
    branch,
    status: 'working',
    createdAt: Date.now()
  }
  ;(m as any).base = baseCommit.get(id)
  s.members[id] = m
  memberProject.set(id, s.projectId)
  s.ready = null
  s.tasks = []
  s.charter = charter
  // a new charter's check starts its own history: the last team's runs measured a different job
  stopCheck(s.projectId)
  delete s.check
  changed(s)
  await startConsole(s, m)
  post(s, { from: 'user', to: id, kind: 'goal', text: goalMessageFor(charter, opts.goal) })
  // the baseline, so later runs can say "down from 11"
  void runCheck(s, 'start')
  return m
}

// ---------------------------------------------------------------- tools

type ToolDef = { name: string; description: string; inputSchema: any; roles: FleetRole[] }
/** `git diff --numstat` → lines added / removed per file (binary files count as 0). */
export function numstat(out: string): { path: string; add: number; del: number }[] {
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3)
    .map(([add, del, ...rest]) => ({ path: rest.join('\t'), add: Number(add) || 0, del: Number(del) || 0 }))
}

/**
 * The commit a branch points at now. Both gates resolve the branch once and then check and merge
 * that commit: a worker is a real CLI that stays alive for follow-ups and knows a merge comes after
 * its report, so a branch name read twice can be two commits — and the second one is the one that
 * lands, unchecked. Nothing downstream takes a branch name again.
 */
async function commitOf(cwd: string, branch: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', `${branch}^{commit}`])
  const sha = r.out.trim()
  return r.ok && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null
}

/**
 * The files merging `commit` into the checkout at `cwd` would bring in — what the exclusions are
 * matched against, at both gates (the Lead's fleet_merge and the user's mergeReady).
 *
 * `-z`: git quotes a non-ASCII name otherwise, and a quoted name matches no exclusion.
 * `--no-renames`: a move touches the file it left.
 */
async function wouldTouch(cwd: string, commit: string): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  const d = await git(cwd, ['diff', '--name-only', '-z', '--no-renames', `HEAD...${commit}`])
  if (!d.ok) return { ok: false, error: (d.err || d.out).slice(0, 300) }
  return { ok: true, files: d.out.split('\0').filter(Boolean) }
}

/** The files among `touched` an exclusion covers, each named with the rule it hit. */
const excludedHits = (touched: string[], wontTouch: string[] | undefined, how: string) =>
  touched.flatMap((f) => {
    const rule = excludedBy(f, wontTouch)
    return rule ? [`${f} (${how} "${rule}")`] : []
  })

const andMore = (hits: string[]) => (hits.length > 5 ? `, and ${hits.length - 5} more` : '')

/** Why a worker's branch cannot be merged: it changed files the charter's won't-touch list rules out. Null when it can. */
export function excludedRefusal(worker: string, touched: string[], wontTouch: string[] | undefined): string | null {
  const hits = excludedHits(touched, wontTouch, 'excluded by')
  if (!hits.length) return null
  return `Not merged: ${worker} changed ${hits.slice(0, 5).join(', ')}${andMore(hits)}, which the user ruled out. Ask ${worker} to revert ${hits.length === 1 ? 'it' : 'them'} with fleet_send, then merge again.`
}

/**
 * The same refusal for the user's own merge, in their words rather than the Lead's. Said by
 * mergeReady, which is the one place every client reaches — the Ready card, and the phone's
 * /api/merge (remote.ts) — so the card hiding its Merge button is the courtesy and this is the rule.
 * Both clients show it after "Merge failed:", so it does not say that itself.
 */
export function excludedMergeRefusal(touched: string[], wontTouch: string[] | undefined): string | null {
  const hits = excludedHits(touched, wontTouch, 'ruled out by')
  if (!hits.length) return null
  return `this work changed ${hits.slice(0, 5).join(', ')}${andMore(hits)}. Tell the Lead to put ${hits.length === 1 ? 'it' : 'them'} back, or discard the team's work.`
}

const str = (description: string) => ({ type: 'string', description })
const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

const TOOLS: ToolDef[] = [
  {
    name: 'fleet_plan',
    roles: ['lead'],
    description: 'Show your plan on the board as a task list (replaces the previous plan). Keep tasks to one line each.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: strArr('Task titles, in order'),
        estimates: { type: 'array', items: { type: 'number' }, description: 'Minutes you expect each task to take, same order as tasks' }
      },
      required: ['tasks']
    }
  },
  {
    name: 'fleet_update_task',
    roles: ['lead'],
    description: 'Update a task on the plan: status (todo, doing, review, done, blocked), owner (worker name) or a short note.',
    inputSchema: { type: 'object', properties: { task: str('Task id, its number in the plan, or its title'), status: str('todo | doing | review | done | blocked'), owner: str('Worker name'), note: str('Short note') }, required: ['task'] }
  },
  {
    name: 'fleet_spawn_worker',
    roles: ['lead'],
    description:
      'Start a worker on one task in its own git worktree (branched from your integration branch). It receives the brief automatically and reports back via fleet_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('The task, specific and self-contained'),
        owns: strArr('Files or folders this worker may edit; no other worker may own them'),
        done_when: str('A check that proves the task is done, e.g. "npm test passes"'),
        agent: str('Agent CLI id: claude (default), codex or gemini'),
        name: str('Optional worker name'),
        task_ref: str('The plan task this worker does: its id (from fleet_plan), number or title')
      },
      required: ['task', 'owns', 'done_when']
    }
  },
  {
    name: 'fleet_spawn_reviewer',
    roles: ['lead'],
    description: 'Start a read-only reviewer in your integration worktree to check the merged work against the goal and run the checks. It reports a verdict via fleet_wait.',
    inputSchema: { type: 'object', properties: { scope: str('What to review and against what goal'), agent: str('claude (default) or codex'), name: str('Optional name') }, required: ['scope'] }
  },
  {
    name: 'fleet_send',
    roles: ['lead', 'worker', 'reviewer'],
    description: 'Send a message to a team member by name (workers: defaults to your lead). It is typed into their console when they are free.',
    inputSchema: { type: 'object', properties: { to: str('Member name; omit to message your lead'), message: str('The message') }, required: ['message'] }
  },
  {
    name: 'fleet_wait',
    roles: ['lead'],
    description: 'Wait for news: worker reports, messages, or the user\'s answers. Returns as soon as something arrives (or after a few minutes with nothing). Call it again to keep waiting.',
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 170)' } } }
  },
  {
    name: 'fleet_merge',
    roles: ['lead'],
    description: "Merge a worker's committed work into your integration branch. Returns conflicts if it can't.",
    inputSchema: { type: 'object', properties: { worker: str('Worker name') }, required: ['worker'] }
  },
  {
    name: 'fleet_dismiss',
    roles: ['lead'],
    description: 'Close a worker or reviewer you no longer need (its console and worktree). Merged work is kept.',
    inputSchema: { type: 'object', properties: { member: str('Name') }, required: ['member'] }
  },
  {
    name: 'fleet_ask_user',
    roles: ['lead'],
    description:
      'Ask the user a decision with 2-4 short options. Shown as a card on their command bar. Give each option a one-line trade-off in notes and say which you would pick, so they can decide at a glance. Waits a while for the answer; if it comes later it is delivered to you.',
    inputSchema: {
      type: 'object',
      properties: {
        question: str('One short question'),
        options: strArr('2-4 short options'),
        notes: strArr('Optional: one short trade-off per option, same order (e.g. "Works today, files vanish on redeploy")'),
        recommended: str('Optional: the option you would pick (its exact text)')
      },
      required: ['question', 'options']
    }
  },
  {
    name: 'fleet_status',
    roles: ['lead', 'worker', 'reviewer'],
    description: 'Team overview: members, their tasks and status, and the plan.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fleet_finish',
    roles: ['lead'],
    description: 'Hand the finished, verified work to the user: shows a Ready card where they merge your branch with one click.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: str('2-5 lines, one change per line starting with "- ": what was done'),
        verified: str('What you checked and its result, e.g. "typecheck and 48 tests pass". Only what you actually ran.')
      },
      required: ['summary']
    }
  },
  {
    name: 'fleet_report',
    roles: ['worker', 'reviewer'],
    description: 'Report back to your lead. Workers: status done or blocked. Reviewers: approve or changes. Your work is committed automatically.',
    inputSchema: { type: 'object', properties: { status: str('done | blocked | approve | changes'), summary: str('Short summary or findings') }, required: ['status', 'summary'] }
  }
]

/**
 * Which roles may call a tool, or null for a name that is not a fleet tool at all.
 *
 * `tools/list` only decides what a member is *told* about. A console reads its own MCP config, so it
 * can send any tool name it likes: this is where the role is actually enforced. Without it a worker
 * — that is, anything able to prompt-inject a worker through a file, issue, dependency or PR comment
 * it reads — can call fleet_finish and put its own unreviewed branch on the user's Ready card, or
 * fleet_dismiss a sibling's unmerged work.
 */
export function toolRoles(name: string): FleetRole[] | null {
  return TOOLS.find((t) => t.name === name)?.roles ?? null
}

/** Why `role` may not call `name`, or null when it may. Says what the caller can use instead. */
export function toolDenial(name: string, role: FleetRole): string | null {
  const roles = toolRoles(name)
  if (!roles) return `Unknown tool ${name}`
  if (roles.includes(role)) return null
  const mine = TOOLS.filter((t) => t.roles.includes(role)).map((t) => t.name)
  return `${name} is for the ${roles.join(' / ')} role; you are a ${role}. Your tools: ${mine.join(', ')}.`
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string) => ({ content: [{ type: 'text', text: t }], isError: true })

async function callTool(callerId: string, name: string, a: any, signal?: AbortSignal): Promise<any> {
  const found = memberOf(callerId)
  if (!found) return fail('This console is not part of a Fleetboard team.')
  const { s, m } = found
  const denied = toolDenial(name, m.role)
  if (denied) return fail(denied)
  const lead = m.role === 'lead' ? m : m.leadId ? s.members[m.leadId] : undefined
  const team = () => Object.values(s.members).filter((x) => x.leadId === (lead?.id ?? m.id) && x.status !== 'closed')

  switch (name) {
    case 'fleet_plan': {
      const estimates: unknown[] = Array.isArray(a.estimates) ? a.estimates : []
      s.tasks = (a.tasks ?? []).map((t: string, i: number): FleetTask => {
        const estimate = estimateOf(estimates[i])
        return { id: uid('t'), title: String(t), status: 'todo', ...(estimate ? { estimate } : {}) }
      })
      ctx.emit('fleet:plan', { leadId: m.id })
      changed(s)
      return text(`Plan shown on the board:\n${s.tasks.map((t, i) => `${i + 1}. ${t.title} (id ${t.id})`).join('\n')}`)
    }
    case 'fleet_update_task': {
      const t = findTask(s.tasks, a.task)
      if (!t) return fail(`No such task. The plan:\n${s.tasks.map((x, i) => `${i + 1}. ${x.title} (id ${x.id})`).join('\n')}`)
      if (a.status) {
        const st = String(a.status).toLowerCase().trim()
        if (!TASK_STATUSES.includes(st as FleetTask['status'])) return fail(`Unknown status "${a.status}". Use one of: ${TASK_STATUSES.join(', ')}.`)
        stampTask(t, st as FleetTask['status'], Date.now())
      }
      if (a.owner) t.owner = findMember(s, a.owner)?.id ?? a.owner
      if (a.note) t.note = a.note
      changed(s)
      return text('Updated.')
    }
    case 'fleet_spawn_worker':
    case 'fleet_spawn_reviewer': {
      const reviewer = name === 'fleet_spawn_reviewer'
      if (!reviewer && team().filter((x) => x.role === 'worker' && x.status === 'working').length >= MAX_WORKERS)
        return fail(`You already have ${MAX_WORKERS} workers running. Wait for reports (fleet_wait) before starting more.`)
      const agentId = String(a.agent ?? '').trim().toLowerCase() || 'claude'
      if (!TEAM_AGENTS.includes(agentId))
        return fail(`${agentById(agentId)?.name ?? `"${a.agent}"`} cannot join a team: it has no way to reach the fleet tools. Use ${TEAM_AGENTS.slice(0, -1).join(', ')} or ${TEAM_AGENTS.at(-1)}.`)
      const id = uid('con')
      const wname = pickName(s, a.name)
      let cwd = m.cwd
      let branch: string | undefined
      if (!reviewer && m.branch) {
        branch = `${m.branch}--${wname.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        try {
          cwd = await createWorktree(m.cwd, s.projectPath, s.projectId, path.basename(m.cwd).replace(/-lead$/, '') + '-' + wname.toLowerCase().replace(/[^a-z0-9]+/g, '-'), branch)
        } catch (e) {
          return fail(String(e))
        }
      }
      const w: FleetMember = {
        id,
        role: reviewer ? 'reviewer' : 'worker',
        name: wname,
        agentId,
        projectId: s.projectId,
        leadId: m.id,
        task: reviewer ? `Review: ${a.scope}` : a.task,
        owns: reviewer ? undefined : a.owns,
        doneWhen: reviewer ? undefined : a.done_when,
        cwd,
        branch,
        status: 'working',
        createdAt: Date.now()
      }
      s.members[id] = w
      memberProject.set(id, s.projectId)
      const ref = reviewer ? undefined : a.task_ref ? findTask(s.tasks, a.task_ref) : guessTask(s.tasks, String(a.task ?? ''))
      if (ref) {
        ref.owner = id
        stampTask(ref, 'doing', Date.now())
      }
      const unlinked = !reviewer && !ref && s.tasks.some((t) => !t.owner && t.status === 'todo')
      changed(s)
      await startConsole(s, w, { acceptEdits: !reviewer })
      post(s, { from: m.id, to: id, kind: 'brief', text: briefFor(w, m, s.charter?.wontTouch) })
      return text(
        `${w.name} started (${agentById(agentId)?.name}) ${branch ? `in its own worktree on branch ${branch}` : 'in your worktree'}. It has the brief.` +
          (ref ? ` On the plan: "${ref.title}".` : '') +
          (unlinked ? ` It is not linked to a plan task${a.task_ref ? ` (no task "${a.task_ref}")` : ''}: call fleet_update_task with the task id and owner ${w.name}.` : '') +
          ' Call fleet_wait to get its report.'
      )
    }
    case 'fleet_send': {
      const to = a.to ? findMember(s, a.to) : lead && lead.id !== m.id ? lead : undefined
      if (!to) return fail(`No team member called "${a.to}". Members: ${Object.values(s.members).map((x) => x.name).join(', ')}`)
      post(s, { from: m.id, to: to.id, kind: 'message', text: String(a.message) })
      return text(`Sent to ${to.name}. It will be typed into their console when they are free.`)
    }
    case 'fleet_wait': {
      const pending = s.messages.filter((x) => x.to === m.id && !x.delivered && x.kind !== 'goal')
      if (pending.length) {
        pending.forEach((x) => (x.delivered = true))
        changed(s)
        return text(pending.map((x) => render(s, x)).join('\n\n'))
      }
      const ms = Math.min(WAIT_CAP_MS, Math.max(5, Number(a.timeout_seconds) || 170) * 1000)
      const events = await new Promise<FleetMessage[]>((resolve) => {
        const finish = (ev: FleetMessage[]) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (waiters.get(m.id) === waiter) waiters.delete(m.id)
          resolve(ev)
        }
        const waiter = (ev: FleetMessage[]) => finish(ev)
        // the caller hung up (interrupted, restarted): stop waiting so news is not handed to nobody
        const onAbort = () => finish([])
        const timer = setTimeout(() => finish([]), ms)
        waiters.set(m.id, waiter)
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort)
      })
      if (signal?.aborted) {
        // arrived as the connection closed: keep it for the next fleet_wait, or to be typed in
        for (const x of events) x.delivered = false
        if (events.length) changed(s)
        return text('')
      }
      if (!events.length) {
        const working = team().filter((x) => x.status === 'working')
        return text(working.length ? `Nothing new yet. Still working: ${working.map((x) => x.name).join(', ')}. Call fleet_wait again.` : 'Nothing new, and nobody is working.')
      }
      changed(s)
      return text(events.map((x) => render(s, x)).join('\n\n'))
    }
    case 'fleet_report': {
      if (!lead) return fail('You have no lead.')
      let commitNote = ''
      if (m.role === 'worker' && m.branch) {
        const add = await git(m.cwd, ADD_ALL)
        if (!add.ok) trouble(s, `${m.name}'s changes could not be staged: ${add.err.slice(0, 160)}. They are still in ${m.cwd}.`)
        const dirty = !(await git(m.cwd, ['diff', '--cached', '--quiet'])).ok
        if (dirty) {
          // subject from the worker's own summary (what changed), body keeps the task it was given
          const summary = String(a.summary).trim()
          const subject = (summary.split('\n')[0] ?? '').replace(/^[-*•\s]+/, '').replace(/\.$/, '').slice(0, 72) || 'Work from ' + m.name
          const c = await git(m.cwd, ['commit', '-m', `${subject}\n\n${summary.slice(0, 2000)}\n\nTask: ${m.task?.slice(0, 500) ?? ''}\nBy ${m.name} (Fleetboard team)`])
          commitNote = c.ok ? ` Committed on ${m.branch}.` : ` (commit failed: ${c.err.slice(0, 200)})`
          // the lead is a model: without this the user never hears that the work was not saved
          if (!c.ok) trouble(s, `${m.name}'s work could not be committed: ${c.err.slice(0, 160)}. It is still in ${m.cwd}.`)
        } else commitNote = ' No file changes.'
      }
      m.status = 'reported'
      m.report = String(a.summary)
      const t = s.tasks.find((x) => x.owner === m.id)
      if (t) stampTask(t, a.status === 'blocked' ? 'blocked' : a.status === 'changes' ? 'review' : m.role === 'reviewer' ? t.status : 'review', Date.now())
      post(s, { from: m.id, to: lead.id, kind: 'report', text: `(${a.status}) ${a.summary}${commitNote}` })
      return text(`Reported to ${lead.name}.${commitNote} Stay available: the lead may send follow-ups.`)
    }
    case 'fleet_merge': {
      const w = findMember(s, a.worker)
      if (!w?.branch) return fail('That worker has no branch to merge.')
      // the commit that is checked is the commit that is merged, whatever the worker commits meanwhile
      const at = await commitOf(m.cwd, w.branch)
      if (!at) return fail(`Not merged: ${w.name}'s branch ${w.branch} is not a commit git can find.`)
      // before the merge, so a refusal leaves the lead's worktree as it was
      const wontTouch = s.charter?.wontTouch
      if (wontTouch?.length) {
        const d = await wouldTouch(m.cwd, at)
        if (!d.ok) return fail(`Not merged: ${w.name}'s changes could not be checked against what the user ruled out: ${d.error}`)
        const refusal = excludedRefusal(w.name, d.files, wontTouch)
        if (refusal) return fail(refusal)
      }
      // -m, or the merge commit would be named after the sha rather than the branch it came from
      const r = await git(m.cwd, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${w.branch}`, at])
      if (!r.ok) {
        const conflicts = (await git(m.cwd, ['diff', '--name-only', '--diff-filter=U'])).out
        await git(m.cwd, ['merge', '--abort'])
        return fail(`Merge failed${conflicts ? `; conflicts in: ${conflicts.split('\n').join(', ')}` : `: ${r.err.slice(0, 400)}`}. Ask ${w.name} to fix it with fleet_send.`)
      }
      w.status = 'merged'
      const t = s.tasks.find((x) => x.owner === w.id)
      if (t) stampTask(t, 'done', Date.now())
      ctx.emit('fleet:traffic', { from: w.id, to: m.id, kind: 'merge' })
      changed(s)
      // merged work has landed in the integration worktree: the one moment the charter's check can answer differently
      void runCheck(s, 'merge')
      const stat = (await git(m.cwd, ['diff', '--stat', 'HEAD~1', 'HEAD'])).out.split('\n').pop()
      return text(`Merged ${w.name}'s work into ${m.branch}: ${stat}`)
    }
    case 'fleet_dismiss': {
      const w = findMember(s, a.member)
      if (!w || w.id === m.id) return fail('No such member.')
      await dismiss(s, w, w.status === 'merged' ? 'merged' : 'keep')
      return text(`${w.name} dismissed.`)
    }
    case 'fleet_ask_user': {
      const options = (a.options ?? []).map(String).slice(0, 4)
      const notes = Array.isArray(a.notes) ? a.notes.slice(0, options.length).map((n: unknown) => String(n ?? '').slice(0, 160)) : undefined
      const rec = a.recommended == null ? -1 : options.findIndex((o: string) => o.toLowerCase() === String(a.recommended).trim().toLowerCase())
      const ask: FleetAsk = { id: uid('ask'), from: m.id, question: String(a.question), options, at: Date.now(), ...(notes?.some(Boolean) ? { notes } : {}), ...(rec >= 0 ? { recommended: rec } : {}) }
      s.asks.push(ask)
      changed(s)
      ctx.emit('fleet:asked', ask)
      const answer = await new Promise<string | null>((resolve) => {
        const finish = (v: string | null) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (askWaiters.get(ask.id) === waiter) askWaiters.delete(ask.id)
          resolve(v)
        }
        const waiter = (v: string) => finish(v)
        // without a listener, the answer is posted to the lead as a message (fleet:answer)
        const onAbort = () => finish(null)
        const timer = setTimeout(() => finish(null), WAIT_CAP_MS)
        askWaiters.set(ask.id, waiter)
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort)
      })
      return text(answer ? `The user chose: ${answer}` : 'No answer yet. Carry on with anything that does not depend on it; the answer will be delivered to you when they choose.')
    }
    case 'fleet_status': {
      const members = Object.values(s.members).filter((x) => x.status !== 'closed' && (x.id === (lead?.id ?? m.id) || x.leadId === (lead?.id ?? m.id)))
      const lines = members.map((x) => `- ${x.name} (${x.role}, ${x.agentId}): ${x.status}, console ${ctx.ptys.status(x.id) ?? 'stopped'}${x.task ? ` - ${x.task}` : ''}`)
      const plan = s.tasks.map((t, i) => `${i + 1}. [${t.status}] ${t.title}${t.owner ? ` (${labelOf(s, t.owner)})` : ''}`)
      return text(`Team:\n${lines.join('\n')}\n\nPlan:\n${plan.join('\n') || '(none)'}`)
    }
    case 'fleet_finish': {
      const verified = a.verified ? String(a.verified).slice(0, 200) : undefined
      if (!m.branch) {
        s.ready = { leadId: m.id, branch: '', summary: String(a.summary), commits: 0, files: [], at: Date.now(), ...(verified ? { verified } : {}) }
      } else {
        const base = baseCommit.get(m.id) ?? 'HEAD~1'
        const commits = Number((await git(m.cwd, ['rev-list', '--count', `${base}..HEAD`])).out) || 0
        const files = (await git(m.cwd, ['diff', '--name-only', `${base}..HEAD`])).out.split('\n').filter(Boolean)
        const stat = numstat((await git(m.cwd, ['diff', '--numstat', `${base}..HEAD`])).out)
        const hasRemote = (await git(m.cwd, ['remote', 'get-url', 'origin'])).ok
        s.ready = { leadId: m.id, branch: m.branch, summary: String(a.summary), commits, files, stat, at: Date.now(), hasRemote, ...(verified ? { verified } : {}) } as FleetReady
      }
      m.status = 'reported'
      changed(s)
      ctx.emit('fleet:ready', s.ready)
      return text('The user now sees a Ready card with your summary and a Merge button. Stay available for follow-ups.')
    }
  }
  return fail(`Unknown tool ${name}`)
}

async function dismiss(s: FleetState, m: FleetMember, branch: 'merged' | 'force' | 'keep') {
  // closed first: the console's exit that follows is expected, not news for the lead
  m.status = 'closed'
  ctx.emit('fleet:removeConsoles', [m.id])
  // its worktree and Gemini home go once its CLI has ended: one still shutting down would write its
  // session into them again (Gemini CLI saves on SIGHUP)
  await ctx.ptys.stop(m.id)
  await removeWorktree(s, m, branch)
  if (m.agentId === 'gemini') removeGeminiTeamHome(m.id)
  changed(s)
}

// ---------------------------------------------------------------- MCP over HTTP (JSON-RPC, streamable HTTP without streams)

async function handleRpc(callerId: string, msg: any, signal?: AbortSignal): Promise<any | null> {
  const reply = (result: any) => ({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.id === undefined || msg.id === null) return null // notification
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fleetboard', version: '1.0.0' },
        instructions: 'Fleetboard team tools: plan, delegate to workers, message, wait for reports, merge, and hand off to the user.'
      })
    case 'ping':
      return reply({})
    case 'tools/list': {
      const role = memberOf(callerId)?.m.role ?? 'worker'
      return reply({ tools: TOOLS.filter((t) => t.roles.includes(role)).map(({ roles: _r, ...t }) => t) })
    }
    case 'tools/call': {
      try {
        return reply(await callTool(callerId, msg.params?.name, msg.params?.arguments ?? {}, signal))
      } catch (e) {
        return reply(fail(`Fleet error: ${String(e)}`))
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
  }
}

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = /^\/mcp\/([^/?]+)\/?(?:\?|$)/.exec(req.url ?? '')
      if (!m) return res.writeHead(404).end()
      const [, encoded = ''] = m
      let caller = encoded
      try {
        caller = decodeURIComponent(encoded)
      } catch {
        /* use as is */
      }
      const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
      if (!sameSecret(token, memberToken(caller)) || refuse(req, port, { json: true })) {
        req.resume()
        return res.writeHead(403).end()
      }
      if (req.method === 'GET') return res.writeHead(405, { Allow: 'POST' }).end()
      if (req.method === 'DELETE') return res.writeHead(200).end()
      if (req.method !== 'POST') return res.writeHead(405).end()
      let body = ''
      // a long call (fleet_wait, fleet_ask_user) must notice when its caller goes away
      const hangup = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) hangup.abort()
      })
      let tooBig = false
      req.on('data', (d) => {
        if (tooBig) return
        body += d
        if (body.length > MAX_BODY) {
          tooBig = true
          body = ''
          res.writeHead(413, { Connection: 'close' }).end()
          req.resume()
        }
      })
      req.on('end', async () => {
        if (tooBig) return
        let parsed: any
        try {
          parsed = JSON.parse(body)
        } catch {
          return res.writeHead(400).end()
        }
        const batch = Array.isArray(parsed)
        const out = (await Promise.all((batch ? parsed : [parsed]).map((x: any) => handleRpc(caller, x, hangup.signal)))).filter(Boolean)
        if (hangup.signal.aborted) return
        if (!out.length) return res.writeHead(202).end()
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': encoded })
        res.end(JSON.stringify(batch ? out : out[0]))
      })
    })
    server.requestTimeout = 0
    server.headersTimeout = 0
    server.keepAliveTimeout = 600_000
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

// ---------------------------------------------------------------- renderer IPC

/** Team consoles started (or restarted) by this run of the app. */
const startedThisRun = new Set<string>()
/** Team consoles whose process ended mid-task during this run. */
const stoppedThisRun = new Set<string>()

/**
 * A team console started again after the app restarted, while its work was unfinished. The CLI is
 * back (its conversation resumed, or fresh) but sitting at its prompt: its turn was cut off with the
 * old app. Queue a briefing, typed in when it is ready, so the team picks up where it was.
 */
function memberStarted(req: PtySpawnRequest) {
  if (startedThisRun.has(req.id)) return
  startedThisRun.add(req.id)
  const found = memberOf(req.id)
  if (!found) return
  const { s, m } = found
  const lead = m.leadId ? s.members[m.leadId] : undefined
  // a worker that died and was reported to its lead, brought back by the user: it carries on
  if (m.role !== 'lead' && m.status === 'reported' && m.report?.startsWith('Console exited') && lead && lead.status !== 'closed') {
    m.status = 'working'
    m.report = undefined
    const t = s.tasks.find((x) => x.owner === m.id)
    if (t) stampTask(t, 'doing', Date.now())
    post(s, { from: m.id, to: lead.id, kind: 'message', text: `${m.name}'s console was restarted; it carries on with its task and will report when done.` })
  }
  if (m.status !== 'working' && m.status !== 'starting') return
  const what = stoppedThisRun.delete(m.id) ? 'Your console was restarted after it stopped.' : 'Fleetboard was restarted.'
  const how = `${what} ${req.resume ? 'Your conversation was restored, but your last step was cut off.' : 'Your previous conversation was not restored.'}`
  if (m.role === 'lead') {
    const crew = Object.values(s.members).filter((x) => x.leadId === m.id && x.status !== 'closed')
    const team = crew.length ? crew.map((x) => `${x.name} (${x.role}): ${x.status === 'working' ? 'still working' : x.status}`).join('; ') : 'nobody started yet'
    post(s, { from: 'user', to: m.id, kind: 'system', text: leadRestartNote({ how, team, task: m.task ?? '', charter: s.charter, resume: !!req.resume }) })
  } else {
    post(s, { from: m.leadId ?? 'user', to: m.id, kind: 'system', text: `[Fleet] ${how} Carry on with your task. ${briefFor(m, lead, s.charter?.wontTouch)}` })
  }
}

/**
 * A member's console ended before it reported (crashed, killed, closed from the board). Tell its lead
 * so the team doesn't wait forever; the work so far stays in the member's worktree.
 */
function memberExited(id: string, code: number | undefined, appClosing: boolean) {
  if (appClosing) return
  const found = memberOf(id)
  if (!found) return
  const { s, m } = found
  if (m.status !== 'working' && m.status !== 'starting') return
  // started again by hand (Restart / Resume on its tile), it gets briefed like after an app restart
  startedThisRun.delete(id)
  stoppedThisRun.add(id)
  // a lead that stopped is shown to the user in the Inbox (its console status is "exited")
  const lead = m.leadId ? s.members[m.leadId] : undefined
  if (!lead || lead.status === 'closed') return
  const how = code ? ` (exit code ${code})` : ''
  m.status = 'reported'
  m.report = `Console exited${how} before reporting.`
  const t = s.tasks.find((x) => x.owner === m.id)
  if (t) stampTask(t, 'blocked', Date.now())
  const work = m.role === 'worker' && m.branch ? ` Anything it changed is uncommitted in its worktree (branch ${m.branch}).` : ''
  post(s, { from: m.id, to: lead.id, kind: 'report', text: `(blocked) ${m.name}'s console exited${how} before it reported.${work} Start a new ${m.role} if the task still needs doing.` })
}

export async function register(c: MainContext) {
  ctx = c
  loadAll()
  ctx.ptys.onExit(memberExited)
  ctx.ptys.onSpawn(memberStarted)
  void findClaudeConfig()
  port = await startServer()
  // kept and unref'd, the way pty.ts and remote.ts handle theirs. Without this they go on ticking
  // through dispose(), typing queued messages into consoles that are being torn down, and a live
  // timer is on its own enough to hold the process open.
  for (const [fn, ms] of [
    [deliverTick, 700],
    [trustTick, 900]
  ] as const) {
    const t = setInterval(fn, ms)
    t.unref?.()
    ticks.push(t)
  }
  startLive({ ctx, teams: () => states.values(), changed, trees: treesDir })

  const { ipc } = ctx
  ipc.handle('fleet:state', (_e, projectId: string, projectPath?: string) => state(projectId, projectPath))
  ipc.handle('fleet:startLead', (_e, opts) => startLead(opts))
  /** whether a team in this folder works in worktrees of its own (a repository with a commit) */
  ipc.handle('fleet:isolation', async (_e, projectPath: string): Promise<'worktrees' | 'no-commits' | 'no-repo'> => {
    if ((await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).ok) return 'worktrees'
    return (await git(projectPath, ['rev-parse', '--git-dir'])).ok ? 'no-commits' : 'no-repo'
  })
  ipc.handle('fleet:ack', (_e, reqId: string, v: { name?: string }) => {
    acks.get(reqId)?.(v ?? {})
    acks.delete(reqId)
  })
  /** The user writes to a team member (usually the lead). */
  ipc.handle('fleet:userMessage', (_e, toId: string, text: string) => {
    const f = memberOf(toId)
    if (!f) return false
    post(f.s, { from: 'user', to: toId, kind: 'goal', text })
    return true
  })
  ipc.handle('fleet:answer', (_e, askId: string, answer: string) => answerAsk(askId, answer))
  /** The user switches the charter's live check off or on. Off also ends a run in flight; on runs it now. */
  ipc.handle('fleet:checkOff', (_e, projectId: string, off: boolean) => {
    const s = states.get(projectId)
    if (!s?.charter?.doneWhen) return false
    s.check = { ...(s.check ?? { command: s.charter.doneWhen, runs: [] }), off: !!off }
    if (!s.check.off) delete s.check.off
    if (off) stopCheck(projectId)
    changed(s)
    if (!off) void runCheck(s, 'start')
    return true
  })
  ipc.handle('fleet:diff', async (_e, projectId: string) => {
    const s = states.get(projectId)
    const lead = s?.ready ? s.members[s.ready.leadId] : undefined
    if (!s || !lead?.branch) return ''
    const base = baseCommit.get(lead.id) ?? 'HEAD~1'
    return (await git(lead.cwd, ['diff', '--stat', '-p', `${base}..HEAD`])).out.slice(0, 400_000)
  })
  ipc.handle('fleet:mergeReady', (_e, projectId: string) => mergeReady(projectId))
  ipc.handle('fleet:revertMerge', (_e, projectId: string, commit: string) => revertMerge(projectId, String(commit)))
  /** Push the team's branch and open a draft PR whose description is the lead's summary. */
  ipc.handle('fleet:openPr', async (_e, projectId: string) => {
    const s = states.get(projectId)
    const lead = s?.ready ? s.members[s.ready.leadId] : undefined
    if (!s?.ready || !lead?.branch) return { ok: false, error: 'Nothing to open a PR for.' }
    const base = (await git(s.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main'
    const push = await git(lead.cwd, ['push', '-u', 'origin', lead.branch])
    if (!push.ok) return { ok: false, error: `Push failed: ${push.err.slice(0, 400)}` }
    const summary = s.ready.summary.trim()
    const title = ((summary.split('\n')[0] ?? '').replace(/^[-*#\s]+/, '').slice(0, 72) || lead.task?.slice(0, 72) || lead.branch).replace(/\.$/, '')
    const body = `${summary}\n\n---\nGoal: ${lead.task ?? ''}\n\nBuilt by a Fleetboard team (${lead.name} and ${Object.values(s.members).filter((x) => x.leadId === lead.id).length} helpers). ${s.ready.commits} commits, ${s.ready.files.length} files.`
    const r = await run('gh', ['pr', 'create', '--draft', '--base', base, '--head', lead.branch, '--title', title, '--body', body], {
      cwd: lead.cwd,
      env: await ghEnv(),
      timeout: 60_000
    })
    if (r.code !== 0) return { ok: false, error: `gh pr create failed: ${r.stderr.trim().slice(0, 400)}` }
    const out = r.stdout.trim()
    const url = out.split('\n').find((l) => l.startsWith('http')) ?? out
    s.ready.prUrl = url
    changed(s)
    return { ok: true, url }
  })
  /** Close the team. A pushed branch (PR) is kept; an empty report-only branch is deleted. */
  ipc.handle('fleet:done', async (_e, projectId: string) => {
    const s = states.get(projectId)
    if (!s?.ready) return false
    const lead = s.members[s.ready.leadId]
    if (!lead) return false
    await dismissTeam(s, lead, s.ready.prUrl ? 'keep' : s.ready.commits ? 'keep' : 'force')
    return true
  })
  ipc.handle('fleet:discard', async (_e, projectId: string, leadId?: string) => {
    const s = states.get(projectId)
    const lead = leadId ? s?.members[leadId] : s?.ready ? s.members[s.ready.leadId] : Object.values(s?.members ?? {}).find((m) => m.role === 'lead' && m.status !== 'closed')
    if (!s || !lead) return false
    await dismissTeam(s, lead, 'force')
    return true
  })
}

/** The user's answer to a lead's question (the Inbox on the board or a phone). */
export function answerAsk(askId: string, answer: string): boolean {
  for (const s of states.values()) {
    const ask = s.asks.find((a) => a.id === askId)
    if (!ask) continue
    if (ask.answer) return false
    ask.answer = answer
    const w = askWaiters.get(askId)
    if (w) {
      askWaiters.delete(askId)
      w(answer)
    } else post(s, { from: 'user', to: ask.from, kind: 'answer', text: `The user answered "${ask.question}": ${answer}` })
    changed(s)
    return true
  }
  return false
}

/** Merge the lead's finished branch into the user's checkout, then dismiss the team. */
/** What the user's checkout is in the middle of (a merge, a rebase…), if anything. */
async function unfinishedOperation(cwd: string): Promise<string | null> {
  const ops: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert']
  ]
  for (const [name, what] of ops) {
    const p = (await git(cwd, ['rev-parse', '--git-path', name])).out
    if (p && fs.existsSync(path.resolve(cwd, p))) return what
  }
  return null
}

const merging = new Set<string>()

/** Merge the Ready work into the user's checkout (whatever branch it is on now), then close the team. */
export async function mergeReady(projectId: string): Promise<{ ok: boolean; into?: string; error?: string; commit?: string }> {
  const s = states.get(projectId)
  if (!s?.ready) return { ok: false, error: 'Nothing is ready.' }
  // the desktop and the phone can both press Merge
  if (merging.has(projectId)) return { ok: false, error: 'Already merging.' }
  merging.add(projectId)
  try {
    const lead = s.members[s.ready.leadId]
    if (!lead) return { ok: false, error: 'The team has no lead to merge from.' }
    if (lead.branch) {
      // the commit that is checked is the commit that is merged: the Lead is still running and may
      // commit again between the two
      const at = await commitOf(s.projectPath, lead.branch)
      if (!at) return { ok: false, error: `The team's branch ${lead.branch} is not a commit git can find, so there is nothing to merge.` }
      // What the user ruled out is enforced here rather than only on the card, because this is the
      // function every client reaches: the Ready card, and the phone's /api/merge. Checked against
      // what the merge would actually bring in, not the file list the card was drawn from, which the
      // Lead may have added to since.
      const wontTouch = s.charter?.wontTouch
      if (wontTouch?.length) {
        const d = await wouldTouch(s.projectPath, at)
        if (!d.ok) return { ok: false, error: `The team's changes could not be checked against what you ruled out: ${d.error}` }
        const refusal = excludedMergeRefusal(d.files, wontTouch)
        if (refusal) return { ok: false, error: refusal }
      }
      const current = await git(s.projectPath, ['symbolic-ref', '-q', '--short', 'HEAD'])
      if (!current.ok) return { ok: false, error: `Your checkout is not on a branch (detached HEAD). Check out the branch to merge into, then merge again; the work stays on ${lead.branch}.` }
      // git would refuse anyway, and the abort below would then throw away the user's own conflict resolution
      const busy = await unfinishedOperation(s.projectPath)
      if (busy) return { ok: false, error: `Your checkout is in the middle of ${busy}. Finish or abort it, then merge again; the work stays on ${lead.branch}.` }
      const r = await git(s.projectPath, ['merge', '--no-ff', '-m', `Merge ${lead.branch}: ${lead.task?.slice(0, 60) ?? ''}`, at])
      if (!r.ok) {
        // undo only a merge this started (a conflict); a merge git refused to start left nothing to undo
        if (await unfinishedOperation(s.projectPath)) await git(s.projectPath, ['merge', '--abort'])
        return { ok: false, error: r.err.slice(0, 600) || r.out.slice(0, 600) }
      }
      // the merge commit, so the Ready card can offer to undo it while it is still the tip
      const commit = (await git(s.projectPath, ['rev-parse', 'HEAD'])).out.trim()
      journal({
        kind: 'fleet.merge',
        text: `the team's branch ${lead.branch} was merged into ${current.out}`,
        project: s.projectPath,
        // which commit: the night log is where you look for a merge you did not watch, and that is
        // the one thing that identifies it afterwards
        detail: { branch: lead.branch, into: current.out, commit, commits: s.ready?.commits, files: s.ready?.files.length }
      })
      await dismissTeam(s, lead, 'merged')
      return { ok: true, into: current.out, ...(commit ? { commit } : {}) }
    }
    await dismissTeam(s, lead, 'keep')
    return { ok: true, into: '' }
  } finally {
    merging.delete(projectId)
  }
}

/**
 * Undo a merge this app just made, as a fresh revert commit.
 *
 * The sha arrives over IPC, so it is matched against a plain hex shape before it reaches git: a
 * `--flag`, a path or a `a..b` range is refused rather than passed through. It also only runs while
 * that merge is still HEAD — once anything is committed on top, reverting it here would quietly
 * undo a merge in the middle of the user's history, so they are told to do it themselves.
 */
export async function revertMerge(projectId: string, commit: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return { ok: false, error: 'That is not a commit id.' }
  const s = states.get(projectId)
  if (!s) return { ok: false, error: 'That project is not open.' }
  const busy = await unfinishedOperation(s.projectPath)
  if (busy) return { ok: false, error: `Your checkout is in the middle of ${busy}. Finish or abort it, then undo the merge.` }
  const head = (await git(s.projectPath, ['rev-parse', 'HEAD'])).out.trim()
  if (head !== commit) return { ok: false, error: 'Your checkout has moved on since that merge, so undoing it here would bury the commits made since. Revert it yourself.' }
  const r = await git(s.projectPath, ['revert', '-m', '1', '--no-edit', commit])
  if (!r.ok) {
    if (await unfinishedOperation(s.projectPath)) await git(s.projectPath, ['revert', '--abort'])
    return { ok: false, error: r.err.slice(0, 600) || r.out.slice(0, 600) }
  }
  return { ok: true }
}

/** A project's team state, if it has one. */
/** Stop the team timers. Called when the app quits. */
export function stopFleetTicks() {
  for (const t of ticks) clearInterval(t)
  ticks.length = 0
  stopLive()
}

export const fleetState = (projectId: string): FleetState | undefined => states.get(projectId)

async function dismissTeam(s: FleetState, lead: FleetMember, branch: 'merged' | 'force' | 'keep') {
  // its worktree is about to go: a check still running in it has nothing left to check
  stopCheck(s.projectId)
  const crew = Object.values(s.members).filter((m) => m.leadId === lead.id && m.status !== 'closed')
  // A worker's branch is only safe to delete once the lead's branch actually contains its commits.
  // It used to be deleted with -D either way, so a worker that reported "blocked", or whose console
  // died before it reported, had its commits made unreachable — after the lead's own report had told
  // the user that work existed.
  // This answer is about the commits that exist now; a rescue commit made during the dismissal would
  // make it stale, which is why branchToDelete has the last word over it.
  for (const m of crew) await dismiss(s, m, (await containedIn(s.projectPath, m.branch, lead.branch)) ? 'force' : 'keep')
  await dismiss(s, lead, branch)
  s.ready = null
  s.tasks = []
  s.asks = s.asks.filter((a) => a.answer)
  changed(s)
}
