import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { dirs, writeJsonAtomic } from './paths'
import { newSecret, refuse, sameSecret } from './localserver'

// Claude Code reports its own lifecycle through hooks. Each console's CLI gets a settings file
// (passed with --settings) whose hooks POST to this local server, so the board shows the CLI's
// own idea of working / idle / needs-you instead of a guess. What each event means for the status
// lives in status.ts (hookStatus); this only receives them.

let port = 0
/** this run's secret, from which each console's own token is made (FB_HOOK_TOKEN in its environment, never in a file) */
const secret = newSecret()
/** good for that console's events only: a console (or what runs in it) cannot report for another */
const consoleToken = (id: string) => crypto.createHmac('sha256', secret).update(id).digest('base64url')
let listener: (id: string, event: string, payload: unknown) => void = () => {}

/**
 * Hook events the settings file subscribes to. Only events Claude Code has long supported: a version
 * that does not know one skips it with a warning. SubagentStop is left out on purpose: it fires for
 * background helpers after the turn ended and says nothing about the console.
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification', 'PreCompact', 'Stop', 'SessionEnd']

const MAX_BODY = 65536

export function startHookServer(onEvent: typeof listener): Promise<number> {
  listener = onEvent
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = /^\/hook\/([^/]+)\/([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '')
      let id = m?.[2] ?? ''
      try {
        id = decodeURIComponent(id)
      } catch {
        /* malformed escape: use it as is */
      }
      if (!m || req.method !== 'POST' || !sameSecret(m[1], consoleToken(id)) || refuse(req, port)) {
        req.resume()
        return res.writeHead(403).end()
      }
      let body = ''
      req.on('data', (d) => (body.length < MAX_BODY ? (body += d) : null))
      req.on('end', () => {
        res.writeHead(204).end()
        let payload: unknown = null
        try {
          payload = JSON.parse(body)
        } catch {
          /* no payload, or cut off at MAX_BODY: the event name still counts */
        }
        listener(id, m[3], payload)
      })
    })
    // the app lives as long as Electron does, not as long as this server listens
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      writeSettingsFile()
      resolve(port)
    })
  })
}

const settingsFile = () => path.join(dirs.hooks, 'claude-hooks.json')

function writeSettingsFile() {
  const cmd = (event: string) => ({
    type: 'command',
    command: `curl -s -m 2 -X POST "http://127.0.0.1:\${FB_HOOK_PORT}/hook/\${FB_HOOK_TOKEN}/\${FB_CONSOLE_ID}/${event}" --data-binary @- -o /dev/null >/dev/null 2>&1 || true`
  })
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ ...(event.endsWith('ToolUse') || event === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [cmd(event)] }]
  }
  writeJsonAtomic(settingsFile(), { hooks }, 0o600)
}

export const hookEnv = (id: string): Record<string, string> => (port ? { FB_HOOK_PORT: String(port), FB_HOOK_TOKEN: consoleToken(id) } : {})
export const claudeHookArgs = (_id: string): string[] => (port ? ['--settings', settingsFile()] : [])
