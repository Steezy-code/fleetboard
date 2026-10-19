import crypto from 'node:crypto'
import type http from 'node:http'

// Fleetboard's local HTTP servers (hooks, the fleet MCP server) listen on 127.0.0.1, which every
// program on the machine can reach, including web pages: a browser (or a web tile) may send simple
// cross-site POSTs to localhost, and DNS rebinding can make a page's own hostname resolve to it.
// So a request must carry this run's secret, come with no browser Origin, address 127.0.0.1 or
// localhost by name, and (for JSON-RPC) be sent as JSON, which a page cannot do without a CORS
// preflight these servers never approve.

export const newSecret = () => crypto.randomBytes(24).toString('hex')

export function sameSecret(given: string | undefined, secret: string) {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Why a request must be refused, or null when it may be served. */
export function refuse(req: http.IncomingMessage, port: number, opts: { json?: boolean } = {}): string | null {
  if (req.headers.origin !== undefined) return 'browser requests are not accepted'
  const host = String(req.headers.host ?? '')
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'wrong host'
  if (opts.json && req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return 'JSON only'
  return null
}
