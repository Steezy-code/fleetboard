import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { MainContext } from './context'
import { describeAnswer, type AnswerResult, type PromptAnswer } from '@shared/prompt'
import { approvalFor } from '@shared/approvals'
import { closeOnly } from '@shared/mergeReview'
import { qrSvg } from '@shared/qr'
import { dirs, readJson, writeJsonAtomic } from './paths'
import { newSecret, sameSecret } from './localserver'
import { currentProject } from './store'
import { answered } from './journal'
import { answerAsk, fleetState, mergeReady } from './fleet'
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from './remote-page'

// The Inbox on a phone. Off until the user turns it on in Settings. It then serves a small page and a
// JSON API on ONE address of this computer: its Tailscale address (encrypted by Tailscale), its LAN
// address (plain HTTP: anyone on the network who sees the traffic could copy the link), or 127.0.0.1.
// Every API call carries a long secret, which lives only in the link's #fragment so it is never sent in
// a URL, a log or a Referer. Requests must address this host by its own address (no DNS rebinding) and,
// from a browser, come from this page's own origin.

export type RemoteNetwork = 'tailscale' | 'lan' | 'local'

interface RemoteConfig {
  enabled: boolean
  network: RemoteNetwork
  token: string
  port: number
}

export interface RemoteStatus {
  enabled: boolean
  network: RemoteNetwork
  running: boolean
  url?: string
  qr?: string
  error?: string
  addresses: { tailscale?: string; lan?: string }
}

const configFile = () => path.join(dirs.root, 'remote.json')
let config: RemoteConfig = { enabled: false, network: 'tailscale', token: '', port: 0 }
let server: http.Server | null = null
let bound: { address: string; port: number } | null = null
let lastError = ''
let ctx: MainContext

// ---------------------------------------------------------------- addresses

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>

const v4 = (ifaces: Ifaces) =>
  Object.entries(ifaces).flatMap(([name, list]) => (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, address: i.address })))

/**
 * A Tailscale address, by interface name as well as range.
 *
 * 100.64.0.0/10 is shared address space, not Tailscale's: a CGNAT ISP, a mobile hotspot and some
 * corporate and VM networks hand out addresses in it on a real interface. On the range alone, the
 * Inbox bound plain HTTP to a carrier-reachable address while Settings called it
 * "Tailscale: encrypted, reachable from your devices anywhere" and skipped the warning the Wi-Fi
 * option shows. The interface is called tailscale0 on Linux and Tailscale on Windows.
 *
 * Getting this wrong the other way is safe: the Tailscale option simply reads as unavailable, and
 * Wi-Fi still works, with the plaintext warning it has always shown.
 */
const TAILSCALE_IFACE = /^tailscale\d*$/i
const isTailscale = (name: string, a: string) => {
  if (!TAILSCALE_IFACE.test(name)) return false
  // a NaN octet fails every comparison below, which is the answer for an address with too few
  const [x = NaN, y = NaN] = a.split('.').map(Number)
  return x === 100 && y >= 64 && y <= 127
}
const isPrivate = (a: string) => {
  const [x = NaN, y = NaN] = a.split('.').map(Number)
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
}
/**
 * Container and VM bridges, reachable from this machine only, and VPN tunnels, which are not the
 * network the phone is on. Windows names its adapters in words ("vEthernet (WSL)", "VirtualBox
 * Host-Only Network"), Linux and macOS in short names.
 */
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|podman|cni|flannel|kube|tun|tap|wg|ppp|utun|vethernet|virtualbox|vmware|hyper-v)|\bwsl\b|\b(tap|tun|vpn|wireguard|zerotier)\b/i
/** a physical Wi-Fi or Ethernet adapter, by Linux, macOS or Windows name */
const PHYSICAL = /^(en|eth|wl|wlan|wi-?fi|ethernet)/i

/** The addresses the phone Inbox could listen on. */
export function findAddresses(ifaces: Ifaces = os.networkInterfaces()): { tailscale?: string; lan?: string } {
  const all = v4(ifaces)
  const tailscale = all.find((i) => isTailscale(i.name, i.address))?.address
  const lan = all.filter((i) => isPrivate(i.address) && !VIRTUAL.test(i.name)).sort((a, b) => Number(PHYSICAL.test(b.name)) - Number(PHYSICAL.test(a.name)))[0]?.address
  return { tailscale, lan }
}

function addressFor(network: RemoteNetwork): string | null {
  if (network === 'local') return '127.0.0.1'
  return findAddresses()[network] ?? null
}

// ---------------------------------------------------------------- requests

/** Why a request must be refused (status code), or null to serve it. */
export function checkRequest(req: { method?: string; headers: http.IncomingHttpHeaders }, host: string, token: string, api: boolean): number | null {
  if (req.headers.host !== host) return 421 // another name for this address: DNS rebinding
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${host}`) return 403
  if (!api) return null
  const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
  if (!sameSecret(auth, token)) return 401
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return 415
  return null
}

/**
 * Too many wrong secrets from one peer: slow down guessing. A 192-bit secret is not guessable, but be
 * polite about it.
 *
 * Per peer, and cleared by a request that got through. One shared counter turned the politeness into
 * a way to switch the feature off: anyone who could reach the port — and the page and its script are
 * served without a token, so the port announces itself — could send thirty wrong tokens a minute and
 * every /api/ request answered 429, the user's own phone included, for as long as they kept it up. A
 * success never cleared it either.
 */
const WINDOW_MS = 60_000
const MAX_WRONG = 30
const PEERS = 1000
const failures = new Map<string, number[]>()

function recent(peer: string): number[] {
  const live = (failures.get(peer) ?? []).filter((t) => t > Date.now() - WINDOW_MS)
  if (live.length) failures.set(peer, live)
  else failures.delete(peer)
  return live
}
export const lockedOut = (peer: string) => recent(peer).length >= MAX_WRONG
export function wrongSecret(peer: string) {
  // a flood of peers must not grow this without end: past the cap, peers whose minute is over go
  // first, so the table never fills with stale ones and stops counting anyone new
  if (!failures.has(peer) && failures.size >= PEERS) for (const p of failures.keys()) recent(p)
  if (!failures.has(peer) && failures.size >= PEERS) return
  failures.set(peer, [...recent(peer), Date.now()])
}
/** This peer knows the secret, so it is the user: forget what it got wrong on the way. */
export const authorized = (peer: string) => void failures.delete(peer)

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY'
}

function send(res: http.ServerResponse, code: number, body: string | object, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (d) => {
      body += d
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
    // destroyed (too big) or the phone went away: no 'end' comes
    req.on('close', () => resolve(null))
  })
}

// ---------------------------------------------------------------- what the phone sees

function consoleNames(): Map<string, { name: string; agentId: string }> {
  const p = currentProject()
  const out = new Map<string, { name: string; agentId: string }>()
  for (const w of p?.workspaces ?? []) for (const n of w.nodes) if (n.type === 'console') out.set(n.id, { name: String(n.data?.name ?? 'Console'), agentId: String(n.data?.agentId ?? '') })
  return out
}

export function remoteState() {
  const p = currentProject()
  const names = consoleNames()
  const live = ctx.ptys.list()
  const consoles = live.map((i) => ({ id: i.id, name: names.get(i.id)?.name ?? i.agentId, agent: names.get(i.id)?.agentId ?? i.agentId, status: ctx.ptys.status(i.id) ?? 'exited' }))
  const approvals = consoles
    .filter((c) => c.status === 'needs-you')
    .map((c) => {
      const a = approvalFor(ctx.ptys.screen(c.id)?.prompt ?? null)
      return { consoleId: c.id, name: c.name, title: a?.title ?? 'Waiting for you in the terminal', detail: a?.detail, options: a?.options ?? [] }
    })
  const fleet = p ? fleetState(p.id) : undefined
  const memberName = (id: string) => fleet?.members[id]?.name ?? 'Lead'
  const ready = fleet?.ready
  return {
    project: p ? { id: p.id, name: p.name } : null,
    consoles,
    approvals,
    asks: (fleet?.asks ?? []).filter((a) => !a.answer).map((a) => ({ id: a.id, from: memberName(a.from), question: a.question, options: a.options })),
    ready: ready ? { lead: memberName(ready.leadId), goal: fleet?.members[ready.leadId]?.task ?? '', summary: ready.summary, branch: ready.branch, commits: ready.commits, files: ready.files.length, closeOnly: closeOnly(ready), prUrl: ready.prUrl, head: ready.head } : null
  }
}

// ---------------------------------------------------------------- server

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!bound) return send(res, 503, { error: 'stopped' })
  const host = `${bound.address}:${bound.port}`
  const url = new URL(req.url ?? '/', `http://${host}`)
  const api = url.pathname.startsWith('/api/')
  const peer = req.socket.remoteAddress ?? 'unknown'
  const refused = checkRequest(req, host, config.token, api)
  if (refused) {
    req.resume()
    // a lockout slows only requests that fail: one with the secret is the user, whoever else shares
    // its address (every client is 127.0.0.1 in "This PC" mode)
    if (refused === 401 && lockedOut(peer)) return send(res, 429, { error: 'too many attempts, wait a minute' })
    if (refused === 401) wrongSecret(peer)
    return send(res, refused, { error: 'refused' })
  }
  if (api) authorized(peer)
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE_HTML, 'text/html; charset=utf-8')
  if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, PAGE_JS, 'text/javascript; charset=utf-8')
  if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, PAGE_CSS, 'text/css; charset=utf-8')
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, remoteState())
  if (req.method === 'GET' && url.pathname === '/api/tail') {
    const id = url.searchParams.get('id') ?? ''
    if (!ctx.ptys.status(id)) return send(res, 404, { error: 'no such console' })
    return send(res, 200, { text: ctx.ptys.tail(id, 6000) })
  }
  if (req.method === 'POST') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad request' })
    if (url.pathname === '/api/answer') {
      const a = body.answer as PromptAnswer
      // always from a card on the phone page, so always marked with it (pty.ts answer checks the mark)
      const valid = a && typeof a === 'object' && typeof (a as any).seen === 'string' && (typeof (a as any).option === 'string' || typeof (a as any).yes === 'boolean' || (a as any).enter === true)
      if (typeof body.consoleId !== 'string' || !valid) return send(res, 400, { error: 'bad answer' })
      const r: AnswerResult = await ctx.ptys.answer(body.consoleId, a)
      if (r.ok) answered('your phone', body.consoleId, describeAnswer(a))
      return send(res, r.ok ? 200 : 409, r)
    }
    if (url.pathname === '/api/ask') {
      if (typeof body.askId !== 'string' || typeof body.answer !== 'string' || !body.answer.trim()) return send(res, 400, { error: 'bad answer' })
      // one of the Lead's options: the phone offers no free text, and its answer reaches the Lead as the user's
      const ok = answerAsk(body.askId, body.answer.trim().slice(0, 500), { fromOptions: true })
      return send(res, ok ? 200 : 409, { ok })
    }
    if (url.pathname === '/api/merge') {
      if (typeof body.projectId !== 'string' || body.confirm !== true) return send(res, 400, { error: 'confirm the merge' })
      // the project the phone was shown, and the card it confirmed
      if (body.projectId !== currentProject()?.id) return send(res, 409, { ok: false, error: 'Another project is open on the computer now.' })
      return send(res, 200, await mergeReady(body.projectId, typeof body.head === 'string' ? body.head : ''))
    }
  }
  return send(res, 404, { error: 'not found' })
}

function save() {
  writeJsonAtomic(configFile(), config, 0o600)
}

function stop() {
  server?.close()
  server?.closeAllConnections?.()
  server = null
  bound = null
}

let queue: Promise<void> = Promise.resolve()
let starting = 0
/** (Re)start on the network's current address; starts run one after another, each with the config of its time. */
function start(): Promise<void> {
  starting++
  const run = queue.then(doStart).finally(() => starting--)
  queue = run.catch(() => {})
  return run
}

async function doStart(): Promise<void> {
  stop()
  lastError = ''
  const address = addressFor(config.network)
  if (!address) {
    lastError = config.network === 'tailscale' ? 'Tailscale is not running on this computer.' : 'No local network address found.'
    return
  }
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((e) => send(res, 500, { error: String(e?.message ?? e) }))
      })
      // anyone who can reach the port can open connections before showing a secret: each is a file
      // descriptor in the main process, which the consoles and board saves need too
      s.maxConnections = 32
      s.headersTimeout = 10_000
      s.requestTimeout = 15_000
      s.keepAliveTimeout = 5_000
      s.once('error', reject)
      s.listen(port, address, () => {
        server = s
        // from here an error is the running server's: say so, rather than leave it to a settled promise
        s.off('error', reject)
        s.on('error', (e) => (lastError = `The Inbox server failed: ${e.message}`))
        resolve((s.address() as { port: number }).port)
      })
    })
  try {
    // keep the same port so a saved link keeps working; take a new one if it is taken
    const port = await listen(config.port).catch(() => listen(0))
    // turned off while it was starting
    if (!config.enabled) return stop()
    bound = { address, port }
    if (port !== config.port) {
      config.port = port
      save()
    }
  } catch (e: any) {
    lastError = `Could not listen on ${address}: ${e?.message ?? e}`
  }
}

/**
 * The address can change under a running Inbox: Tailscale connects after the app starts at login, Wi-Fi
 * hands out a new address, the laptop moves networks. While it is on, follow the network's address:
 * listen once there is one, move when it changes, stop listening when it is gone (and say so).
 */
export async function followAddress(): Promise<boolean> {
  if (!config.enabled || starting) return false
  const want = addressFor(config.network)
  if (want === (bound?.address ?? null) && (bound || !lastError.startsWith('Could not listen'))) return false
  const before = `${bound?.address}:${bound?.port}:${lastError}`
  await start()
  const changed = before !== `${bound?.address}:${bound?.port}:${lastError}`
  if (changed) {
    ctx?.emit('remote:changed')
    // and the top bar's chip, which is there so the Inbox is never on unnoticed
    ctx?.emit('remote:status', { running: !!bound, network: config.network })
  }
  return changed
}
let follower: NodeJS.Timeout | null = null

export function remoteStatus(): RemoteStatus {
  const url = bound ? `http://${bound.address}:${bound.port}/#${config.token}` : undefined
  const status: RemoteStatus = { enabled: config.enabled, network: config.network, running: !!bound, url, qr: url ? qrSvg(url, 220) : undefined, error: lastError || undefined, addresses: findAddresses() }
  // the top bar shows whether it is on (it gets no link or code)
  ctx?.emit('remote:status', { running: status.running, network: status.network })
  return status
}

export async function register(c: MainContext) {
  ctx = c
  config = { ...config, ...readJson<Partial<RemoteConfig>>(configFile(), {}) }
  if (!config.token) {
    config.token = newSecret()
    save()
  }
  if (config.enabled) await start()
  follower ??= setInterval(() => void followAddress().catch(() => {}), 10_000)
  follower.unref?.()
  c.ipc.handle('remote:status', () => remoteStatus())
  c.ipc.handle('remote:enable', async (_e, network: RemoteNetwork) => {
    if (!['tailscale', 'lan', 'local'].includes(network)) throw new Error('bad network')
    // Wi-Fi carries the link in the clear: a link from there does not work on another network, nor one into it
    if (network !== config.network && (network === 'lan' || config.network === 'lan')) config.token = newSecret()
    config.enabled = true
    config.network = network
    save()
    await start()
    return remoteStatus()
  })
  c.ipc.handle('remote:disable', () => {
    config.enabled = false
    // a link that crossed a network once does not work again after Off
    config.token = newSecret()
    save()
    stop()
    return remoteStatus()
  })
  /** A new secret: the old link stops working at once. */
  c.ipc.handle('remote:reset', async () => {
    config.token = newSecret()
    save()
    if (config.enabled) await start()
    return remoteStatus()
  })
}
