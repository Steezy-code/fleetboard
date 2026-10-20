import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeOf } from './platform'

// Each Claude Code / Gemini CLI console gets its own conversation id, so reopening the board resumes
// that console's conversation. The CLIs' own "continue" picks the most recent conversation in the
// folder, and a board usually has several consoles in one folder: they would all resume the same one.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validSessionId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id)
export const newSessionId = () => crypto.randomUUID()

/**
 * What the CLI has under this id, for a console in `cwd`:
 *  - resumable: a conversation to pick up (--resume <id>)
 *  - taken: the id is in use but there is nothing to resume (Gemini saves a session as soon as it
 *    starts); resuming it fails and so does starting under it again: the console needs a new id
 *  - free: nothing yet (Claude Code saves a conversation once something was said); start under it
 *  - lost: the CLI had a conversation under it but can no longer resume it (see Gemini below); a new
 *    id, and the user is told
 * Checked against the real CLIs: each refuses to resume what is not resumable, and to start under a
 * taken id ("already in use" / "already exists").
 */
export type SessionState = 'resumable' | 'taken' | 'free' | 'lost'

export function sessionState(agentId: string, id: string, env: Record<string, string | undefined>, cwd: string): SessionState {
  if (!validSessionId(id)) return 'free'
  const home = homeOf(env)
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p)
    } catch {
      return []
    }
  }
  if (agentId === 'claude') {
    // <config>/projects/<the cwd, encoded>/<id>.jsonl; Claude Code resumes an id from any folder
    const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects')
    return dirs(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`))) ? 'resumable' : 'free'
  }
  if (agentId === 'gemini') {
    // ~/.gemini/tmp/<project>/chats/session-<time>-<first 8 of the id>.jsonl (older: .json). Gemini looks
    // only in the folder's own project, which the file records as sha256(folder)
    const root = path.join(home, '.gemini', 'tmp')
    const project = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex')
    let lost = false
    for (const d of dirs(root)) {
      const chats = path.join(root, d, 'chats')
      for (const f of dirs(chats)) {
        if (!f.includes(id.slice(0, 8))) continue
        const chat = readGeminiChat(path.join(chats, f))
        // a file without its header: Gemini deletes a session that has nothing said yet when another
        // Gemini starts in the same project, even a running one, which then writes on without a header.
        // Gemini cannot resume that; a new id keeps clear of it
        if (chat && chat.sessionId === undefined && chat.said) lost = true
        if (chat?.sessionId !== id || (chat.projectHash && chat.projectHash !== project)) continue
        return chat.said ? 'resumable' : 'taken'
      }
    }
    return lost ? 'lost' : 'free'
  }
  if (agentId === 'codex') return hasCodexSession(env, id) ? 'resumable' : 'free'
  return 'free'
}

/** A Gemini chat file's id and project, and whether anything was said in it. */
function readGeminiChat(file: string): { sessionId?: string; projectHash?: string; said: boolean } | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const records: any[] = []
  if (file.endsWith('.jsonl')) {
    for (const line of text.split('\n')) {
      try {
        records.push(JSON.parse(line))
      } catch {
        /* partial line */
      }
    }
  } else {
    try {
      const doc = JSON.parse(text)
      records.push(doc, ...(Array.isArray(doc?.messages) ? doc.messages : []))
    } catch {
      return null
    }
  }
  const head = records.find((r) => r && typeof r.sessionId === 'string' && typeof r.type !== 'string')
  // the user's words or a reply; not the session context Gemini adds by itself
  const said = records.some(
    (r) => r?.type === 'gemini' || (r?.type === 'user' && !/^\s*<session_context>/.test(Array.isArray(r.content) ? r.content.map((c: any) => c?.text ?? '').join('') : String(r.content ?? '')))
  )
  return { sessionId: head?.sessionId, projectHash: head?.projectHash, said }
}

// ---------------------------------------------------------------- Codex
// Codex cannot be started under a given id. Its sessions are files that record the id, the folder
// and what was said: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. After a
// console's first turn, the new session in its folder that no other console has is its own.

const codexRoot = (env: Record<string, string | undefined>) => path.join(env.CODEX_HOME || path.join(homeOf(env), '.codex'), 'sessions')

function readDir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

/** Rollout files under the sessions dir, in day folders from `sinceDay` (YYYY-MM-DD) on. */
function rollouts(root: string, sinceDay = ''): string[] {
  const out: string[] = []
  for (const y of readDir(root).filter((d) => /^\d{4}$/.test(d)))
    for (const m of readDir(path.join(root, y)).filter((d) => /^\d\d$/.test(d)))
      for (const d of readDir(path.join(root, y, m)).filter((x) => /^\d\d$/.test(x))) {
        if (`${y}-${m}-${d}` < sinceDay) continue
        for (const f of readDir(path.join(root, y, m, d))) if (/^rollout-.+\.jsonl$/.test(f)) out.push(path.join(root, y, m, d, f))
      }
  return out
}

export interface CodexSession {
  id: string
  cwd: string
  startedAt: number
  /** the first thing the user said, when said */
  firstPrompt?: string
}

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : typeof content === 'string' ? content : ''

/** The id, folder and first prompt of a rollout, from its first lines. */
export function readCodexSession(file: string): CodexSession | null {
  let head: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  let meta: CodexSession | null = null
  for (const line of head.split('\n')) {
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const p = o?.payload ?? {}
    if (o?.type === 'session_meta' && !meta) {
      if (!validSessionId(p.id) || typeof p.cwd !== 'string') return null
      meta = { id: p.id, cwd: p.cwd, startedAt: Date.parse(p.timestamp ?? o.timestamp) || 0 }
      continue
    }
    if (!meta) continue
    // what the user typed: an event, or the user message itself (not the context Codex adds as one)
    const said =
      o?.type === 'event_msg' && p.type === 'user_message'
        ? String(p.message ?? '')
        : o?.type === 'response_item' && p.type === 'message' && p.role === 'user'
          ? textOf(p.content)
          : ''
    if (said && !/^\s*<(environment_context|user_instructions|permissions|collaboration_mode|turn_aborted)\b/.test(said)) {
      meta.firstPrompt = said
      break
    }
  }
  return meta
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * The Codex session a console started at `since` in `cwd` is running, if it can be told for sure: a
 * new, unclaimed session in that folder whose first prompt is on this console's screen, and only one.
 * (Being the only new session is not enough: it may be a sibling console's, when this one's turn
 * never reached the model.)
 */
export function findCodexSession(env: Record<string, string | undefined>, opts: { cwd: string; since: number; claimed: Set<string>; screen: string }): string | undefined {
  const day = new Date(opts.since - 24 * 3600_000)
  const sinceDay = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b)
  const found = rollouts(codexRoot(env), sinceDay)
    .map(readCodexSession)
    .filter((s): s is CodexSession => !!s && s.startedAt >= opts.since - 5000 && same(s.cwd, opts.cwd) && !opts.claimed.has(s.id))
  const screen = squash(opts.screen)
  // the start of it: a long prompt wraps on screen
  const shown = found.filter((s) => s.firstPrompt && squash(s.firstPrompt) && screen.includes(squash(s.firstPrompt).slice(0, 40)))
  return shown.length === 1 ? shown[0]?.id : undefined
}

/** Whether Codex has a session file with this id. */
export function hasCodexSession(env: Record<string, string | undefined>, id: string): boolean {
  return validSessionId(id) && rollouts(codexRoot(env)).some((f) => f.endsWith(`-${id}.jsonl`))
}
