import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MainContext } from './context'
import { dirs, readJson, writeJsonAtomic } from './paths'
import { listProfiles } from './profiles'

// Usage pill + token analytics, read from the CLIs' own local session logs. Nothing leaves the machine.
//   Claude Code: <config>/projects/**/*.jsonl  — assistant lines carry message.usage
//   Codex:       <home>/sessions/YYYY/MM/DD/*.jsonl — token_count events (cumulative totals)
//   Gemini CLI:  ~/.gemini/tmp/**/chats/*.json (best effort) — messages[].tokens
// Parsed results are cached per file by mtime + size (memory and ~/.fleetboard/usage-cache.json).

export type UsageAgent = 'claude' | 'codex' | 'gemini'
export const USAGE_AGENTS: UsageAgent[] = ['claude', 'codex', 'gemini']

export interface Tot {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

export interface AgentUsage {
  lifetime: Tot
  last30: Tot
  byModel: { model: string; lifetime: Tot; last30: Tot }[]
  sessions: number
  activeDays: number
  peakDay: { date: string; total: number } | null
  currentStreak: number
  longestStreak: number
  longestSession: { ms: number; date: string } | null
  favoriteModel: string | null
  /** daily totals, oldest first, ending today (364 days) */
  heatmap: { date: string; total: number }[]
  firstSeen: number | null
  lastSeen: number | null
  files: number
}

export interface UsageReport {
  generatedAt: number
  agents: Record<UsageAgent, AgentUsage>
  /** last 90 days, oldest first */
  days: ({ date: string } & Record<UsageAgent, Tot>)[]
  roots: { agent: UsageAgent; dir: string; exists: boolean }[]
}

export interface UsageWindow {
  /** tokens counted against the budget: input + output + cache writes (cache reads excluded) */
  tokens: number
  start: number | null
  resetsAt: number | null
  active: boolean
  byModel: { model: string; tokens: number }[]
}

export interface UsageLimits {
  agent: UsageAgent
  estimate: true
  session: UsageWindow
  week: UsageWindow
  lastActivity: number | null
}

/** compact event: [time ms, model index, input, output, cacheCreate, cacheRead, sessionIndex, dedupe id] */
type Ev = [number, number, number, number, number, number, number, string]

interface FileEntry {
  agent: UsageAgent
  mtime: number
  size: number
  models: string[]
  sessions: string[]
  events: Ev[]
}

const CACHE_FILE = path.join(dirs.root, 'usage-cache.json')
const CACHE_VERSION = 2
const HOUR = 3600_000
const DAY = 24 * HOUR

let cache = new Map<string, FileEntry>()
let cacheLoaded = false
let cacheDirty = false
let scanning: Promise<void> | null = null
let lastScan = 0
let report: UsageReport | null = null
let reportAt = -1
let emit: MainContext['emit'] = () => {}

function loadCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  const raw = readJson<{ v: number; files: Record<string, FileEntry> } | null>(CACHE_FILE, null)
  if (raw?.v === CACHE_VERSION && raw.files) cache = new Map(Object.entries(raw.files))
}

function saveCache() {
  if (!cacheDirty) return
  cacheDirty = false
  try {
    writeJsonAtomic(CACHE_FILE, { v: CACHE_VERSION, files: Object.fromEntries(cache) })
  } catch {
    /* cache is an optimization only */
  }
}

// ---------- roots ----------

function roots(): { agent: UsageAgent; dir: string; exists: boolean }[] {
  const home = os.homedir()
  const list: { agent: UsageAgent; dir: string }[] = [
    { agent: 'claude', dir: path.join(home, '.claude', 'projects') },
    { agent: 'codex', dir: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions') },
    { agent: 'gemini', dir: path.join(home, '.gemini', 'tmp') }
  ]
  if (process.env.CLAUDE_CONFIG_DIR) list.push({ agent: 'claude', dir: path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') })
  try {
    for (const p of listProfiles()) {
      if (p.agentId === 'claude') list.push({ agent: 'claude', dir: path.join(p.dir, 'projects') })
      if (p.agentId === 'codex') list.push({ agent: 'codex', dir: path.join(p.dir, 'sessions') })
    }
  } catch {
    /* profiles index unreadable */
  }
  const seen = new Set<string>()
  return list
    .filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)))
    .map((r) => ({ ...r, exists: fs.existsSync(r.dir) }))
}

async function walk(dir: string, agent: UsageAgent, out: string[], depth = 0) {
  if (depth > 8) return
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, agent, out, depth + 1)
    else if (e.isFile()) {
      if (agent === 'gemini' ? /\.jsonl?$/.test(e.name) : e.name.endsWith('.jsonl')) out.push(p)
    }
  }
}

// ---------- parsers ----------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const ts = (v: unknown) => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

class Builder {
  models: string[] = []
  sessions: string[] = []
  events: Ev[] = []
  private mIdx = new Map<string, number>()
  private sIdx = new Map<string, number>()
  model(m: string) {
    let i = this.mIdx.get(m)
    if (i === undefined) this.mIdx.set(m, (i = this.models.push(m) - 1))
    return i
  }
  session(s: string) {
    let i = this.sIdx.get(s)
    if (i === undefined) this.sIdx.set(s, (i = this.sessions.push(s) - 1))
    return i
  }
}

export function parseClaude(text: string, file: string): Omit<FileEntry, 'mtime' | 'size' | 'agent'> {
  const b = new Builder()
  const byId = new Map<string, number>()
  const fallbackSession = path.basename(file, '.jsonl')
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const msg = o?.message
    const u = msg?.usage
    if (!u || o.type !== 'assistant') continue
    const model = String(msg.model || 'unknown')
    if (model === '<synthetic>') continue
    const t = ts(o.timestamp)
    if (!t) continue
    const id = `${msg.id ?? ''}:${o.requestId ?? ''}`
    const ev: Ev = [
      t,
      b.model(model),
      num(u.input_tokens),
      num(u.output_tokens),
      num(u.cache_creation_input_tokens),
      num(u.cache_read_input_tokens),
      b.session(String(o.sessionId || fallbackSession)),
      id
    ]
    // Claude Code writes one line per content block of the same message; keep the last (final) usage.
    const prev = id !== ':' ? byId.get(id) : undefined
    if (prev !== undefined) {
      const p = b.events[prev]
      ev[3] = Math.max(ev[3], p[3])
      b.events[prev] = ev
    } else {
      if (id !== ':') byId.set(id, b.events.length)
      b.events.push(ev)
    }
  }
  return { models: b.models, sessions: b.sessions, events: b.events }
}

export function parseCodex(text: string, file: string): Omit<FileEntry, 'mtime' | 'size' | 'agent'> {
  const b = new Builder()
  let model = 'codex'
  let session = path.basename(file, '.jsonl')
  let prevTotal = -1
  let n = 0
  for (const line of text.split('\n')) {
    if (!line || !(line.includes('token_count') || line.includes('turn_context') || line.includes('session_meta') || line.includes('"model"')))
      continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const p = o?.payload ?? o
    if (o?.type === 'session_meta' || p?.type === 'session_meta') {
      if (p?.id) session = String(p.id)
      if (p?.model) model = String(p.model)
      continue
    }
    if (o?.type === 'turn_context' || p?.type === 'turn_context') {
      if (p?.model) model = String(p.model)
      continue
    }
    if (p?.type !== 'token_count' && o?.type !== 'token_count') {
      if (typeof p?.model === 'string' && !o?.type) model = p.model
      continue
    }
    const info = p.info ?? p
    if (!info) continue
    const t = ts(o.timestamp ?? p.timestamp)
    if (!t) continue
    const total = info.total_token_usage
    const last = info.last_token_usage
    let use: any = null
    if (total && typeof total === 'object') {
      const tt = num(total.total_tokens) || num(total.input_tokens) + num(total.output_tokens)
      if (tt <= prevTotal) continue // repeated report of the same totals
      if (last && typeof last === 'object') use = last
      else use = prevTotal < 0 ? total : { input_tokens: tt - prevTotal }
      prevTotal = tt
    } else if (last && typeof last === 'object') {
      use = last
    } else if (info.input_tokens !== undefined) {
      use = info
    }
    if (!use) continue
    const cached = num(use.cached_input_tokens)
    const input = Math.max(0, num(use.input_tokens) - cached)
    const output = num(use.output_tokens)
    b.events.push([t, b.model(model), input, output, 0, cached, b.session(session), `cx${n++}`])
  }
  return { models: b.models, sessions: b.sessions, events: b.events }
}

export function parseGemini(text: string, file: string): Omit<FileEntry, 'mtime' | 'size' | 'agent'> {
  const b = new Builder()
  const docs: any[] = []
  if (file.endsWith('.jsonl')) {
    for (const line of text.split('\n')) {
      if (!line.includes('tokens')) continue
      try {
        docs.push(JSON.parse(line))
      } catch {
        /* skip */
      }
    }
  } else {
    if (!text.includes('tokens')) return { models: [], sessions: [], events: [] }
    try {
      docs.push(JSON.parse(text))
    } catch {
      return { models: [], sessions: [], events: [] }
    }
  }
  let n = 0
  const session = path.basename(file).replace(/\.jsonl?$/, '')
  const visit = (o: any, sess: string, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 6) return
    if (Array.isArray(o)) {
      for (const x of o) visit(x, sess, depth + 1)
      return
    }
    if (o.sessionId) sess = String(o.sessionId)
    const tk = o.tokens
    if (tk && typeof tk === 'object' && (tk.input !== undefined || tk.output !== undefined)) {
      const t = ts(o.timestamp)
      if (t) {
        const cached = num(tk.cached)
        b.events.push([
          t,
          b.model(String(o.model || 'gemini')),
          Math.max(0, num(tk.input) - cached),
          num(tk.output) + num(tk.thoughts),
          0,
          cached,
          b.session(sess),
          `gm${n++}`
        ])
      }
      return
    }
    for (const k of ['messages', 'history', 'items', 'entries']) if (o[k]) visit(o[k], sess, depth + 1)
  }
  for (const d of docs) visit(d, session, 0)
  return { models: b.models, sessions: b.sessions, events: b.events }
}

const PARSERS: Record<UsageAgent, (text: string, file: string) => Omit<FileEntry, 'mtime' | 'size' | 'agent'>> = {
  claude: parseClaude,
  codex: parseCodex,
  gemini: parseGemini
}

// ---------- scan ----------

/** Rescan changed files. Cheap when nothing changed (one stat per file). */
async function scan(force = false) {
  loadCache()
  if (scanning) return scanning
  if (!force && Date.now() - lastScan < 15_000) return
  scanning = (async () => {
    const files: { agent: UsageAgent; file: string }[] = []
    for (const r of roots()) {
      if (!r.exists) continue
      const out: string[] = []
      await walk(r.dir, r.agent, out)
      for (const f of out) files.push({ agent: r.agent, file: f })
    }
    const live = new Set(files.map((f) => f.file))
    for (const k of [...cache.keys()]) if (!live.has(k)) (cache.delete(k), (cacheDirty = true))

    const todo: { agent: UsageAgent; file: string; mtime: number; size: number }[] = []
    for (const f of files) {
      try {
        const st = await fs.promises.stat(f.file)
        const c = cache.get(f.file)
        if (force || !c || c.mtime !== st.mtimeMs || c.size !== st.size || c.agent !== f.agent)
          todo.push({ ...f, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* vanished */
      }
    }
    const totalBytes = todo.reduce((s, f) => s + f.size, 0)
    let doneBytes = 0
    let lastEmit = 0
    for (const f of todo) {
      try {
        const text = await fs.promises.readFile(f.file, 'utf8')
        const parsed = PARSERS[f.agent](text, f.file)
        cache.set(f.file, { agent: f.agent, mtime: f.mtime, size: f.size, ...parsed })
        cacheDirty = true
      } catch {
        /* unreadable file */
      }
      doneBytes += f.size
      if (totalBytes > 8e6 && Date.now() - lastEmit > 250) {
        lastEmit = Date.now()
        emit('usage:progress', { done: doneBytes, total: totalBytes, files: todo.length })
      }
      // keep the main process responsive on big histories
      await new Promise((r) => setImmediate(r))
    }
    if (todo.length) {
      reportAt = -1
      saveCache()
      emit('usage:progress', { done: totalBytes, total: totalBytes, files: todo.length, finished: true })
      emit('usage:updated')
    }
    lastScan = Date.now()
  })().finally(() => {
    scanning = null
  })
  return scanning
}

// ---------- aggregation ----------

const zero = (): Tot => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 })
const add = (t: Tot, e: Ev) => {
  t.input += e[2]
  t.output += e[3]
  t.cacheCreate += e[4]
  t.cacheRead += e[5]
  t.total += e[2] + e[3] + e[4] + e[5]
}
const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** day keys from `n-1` days ago up to today */
function dayRange(n: number): string[] {
  const out: string[] = []
  const today = startOfDay(Date.now())
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push(dayKey(d.getTime()))
  }
  return out
}

interface FlatEv {
  t: number
  model: string
  session: string
  e: Ev
}

/** All events of one agent across files, deduplicated (resumed sessions repeat history). */
function eventsOf(agent: UsageAgent): FlatEv[] {
  const seen = new Set<string>()
  const out: FlatEv[] = []
  for (const [file, f] of cache) {
    if (f.agent !== agent) continue
    for (const e of f.events) {
      const id = e[7]
      if (agent === 'claude' && id !== ':') {
        if (seen.has(id)) continue
        seen.add(id)
      }
      out.push({ t: e[0], model: f.models[e[1]] ?? 'unknown', session: f.sessions[e[6]] ?? file, e })
    }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

function agentUsage(agent: UsageAgent, evs: FlatEv[]): AgentUsage {
  const lifetime = zero()
  const last30 = zero()
  const cut30 = startOfDay(Date.now()) - 29 * DAY
  const models = new Map<string, { lifetime: Tot; last30: Tot }>()
  const daily = new Map<string, number>()
  const sessions = new Map<string, number[]>()
  for (const x of evs) {
    add(lifetime, x.e)
    let m = models.get(x.model)
    if (!m) models.set(x.model, (m = { lifetime: zero(), last30: zero() }))
    add(m.lifetime, x.e)
    if (x.t >= cut30) {
      add(last30, x.e)
      add(m.last30, x.e)
    }
    const k = dayKey(x.t)
    daily.set(k, (daily.get(k) ?? 0) + x.e[2] + x.e[3] + x.e[4] + x.e[5])
    let s = sessions.get(x.session)
    if (!s) sessions.set(x.session, (s = []))
    s.push(x.t)
  }
  const byModel = [...models.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.lifetime.total - a.lifetime.total)

  let peakDay: AgentUsage['peakDay'] = null
  for (const [date, total] of daily) if (!peakDay || total > peakDay.total) peakDay = { date, total }

  // streaks over calendar days
  const activeKeys = new Set(daily.keys())
  let longestStreak = 0
  let run = 0
  let prev: number | null = null
  for (const k of [...activeKeys].sort()) {
    const t = new Date(k + 'T00:00:00').getTime()
    run = prev !== null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    prev = t
  }
  let currentStreak = 0
  {
    const d = new Date(startOfDay(Date.now()))
    // today not active yet still keeps yesterday's streak alive
    if (!activeKeys.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1)
    while (activeKeys.has(dayKey(d.getTime()))) {
      currentStreak++
      d.setDate(d.getDate() - 1)
    }
  }

  // longest session: active time, ignoring idle gaps over 30 minutes
  let longestSession: AgentUsage['longestSession'] = null
  for (const times of sessions.values()) {
    let ms = 0
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1]
      if (gap < 30 * 60_000) ms += gap
    }
    if (!longestSession || ms > longestSession.ms) longestSession = { ms, date: dayKey(times[0]) }
  }

  const heatmap = dayRange(364).map((date) => ({ date, total: daily.get(date) ?? 0 }))
  const favorite = byModel.filter((m) => m.model !== 'unknown').sort((a, b) => b.last30.total - a.last30.total || b.lifetime.total - a.lifetime.total)[0]
  const files = [...cache.values()].filter((f) => f.agent === agent).length
  return {
    lifetime,
    last30,
    byModel,
    sessions: sessions.size,
    activeDays: activeKeys.size,
    peakDay,
    currentStreak,
    longestStreak,
    longestSession,
    favoriteModel: favorite?.model ?? null,
    heatmap,
    firstSeen: evs[0]?.t ?? null,
    lastSeen: evs[evs.length - 1]?.t ?? null,
    files
  }
}

function buildReport(): UsageReport {
  if (report && reportAt === lastScan) return report
  const agents = {} as Record<UsageAgent, AgentUsage>
  const days = dayRange(90).map((date) => ({ date, claude: zero(), codex: zero(), gemini: zero() }))
  const dayIdx = new Map(days.map((d, i) => [d.date, i]))
  for (const a of USAGE_AGENTS) {
    const evs = eventsOf(a)
    agents[a] = agentUsage(a, evs)
    for (const x of evs) {
      const i = dayIdx.get(dayKey(x.t))
      if (i !== undefined) add(days[i][a], x.e)
    }
  }
  report = { generatedAt: Date.now(), agents, days, roots: roots() }
  reportAt = lastScan
  return report
}

/** Billable-ish weight used for plan estimates: everything except cache reads. */
const weight = (e: Ev) => e[2] + e[3] + e[4]

/**
 * Rolling-window estimate like the CLIs' plan limits: a window opens at the first message after the
 * previous one expired and lasts `span`. Returns the window containing now (or the last one).
 */
function windowOf(evs: FlatEv[], span: number): UsageWindow {
  const now = Date.now()
  let start: number | null = null
  for (const x of evs) {
    if (x.t < now - 5 * span) continue
    if (start === null || x.t >= start + span) start = x.t
  }
  if (start === null || now >= start + span) return { tokens: 0, start: null, resetsAt: null, active: false, byModel: [] }
  let tokens = 0
  const models = new Map<string, number>()
  for (const x of evs) {
    if (x.t < start) continue
    const w = weight(x.e)
    tokens += w
    models.set(x.model, (models.get(x.model) ?? 0) + w)
  }
  return {
    tokens,
    start,
    resetsAt: start + span,
    active: true,
    byModel: [...models.entries()].map(([model, t]) => ({ model, tokens: t })).sort((a, b) => b.tokens - a.tokens)
  }
}

function limits(agent: UsageAgent): UsageLimits {
  const evs = eventsOf(agent)
  return {
    agent,
    estimate: true,
    session: windowOf(evs, 5 * HOUR),
    week: windowOf(evs, 7 * DAY),
    lastActivity: evs[evs.length - 1]?.t ?? null
  }
}

export function register(ctx: MainContext) {
  emit = ctx.emit
  ctx.ipc.handle('usage:tokens', async (_e, opts?: { force?: boolean }) => {
    await scan(!!opts?.force)
    return buildReport()
  })
  ctx.ipc.handle('usage:limits', async (_e, agent?: UsageAgent) => {
    await scan(false)
    if (agent) return limits(agent)
    return USAGE_AGENTS.map(limits)
  })
  ctx.ipc.handle('usage:scanning', () => !!scanning)
  // warm the cache in the background shortly after launch
  setTimeout(() => scan(false).catch(() => {}), 2500)
}
