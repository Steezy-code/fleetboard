import http from 'node:http'
import path from 'node:path'
import type { ConsoleStatus } from '@shared/types'
import { dirs, writeJsonAtomic } from './paths'

// Claude Code reports its own lifecycle through hooks. Each console's CLI gets a settings file
// (passed with --settings) whose hooks POST to this local server, so the board shows the CLI's
// own idea of working / idle / needs-you instead of a guess.

let port = 0
let listener: (id: string, status: ConsoleStatus, event: string) => void = () => {}

const EVENT_STATUS: Record<string, ConsoleStatus> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'needs-you',
  Stop: 'idle',
  SubagentStop: 'working',
  SessionEnd: 'done'
}

export function startHookServer(onStatus: typeof listener): Promise<number> {
  listener = onStatus
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = /^\/hook\/([^/]+)\/([A-Za-z]+)/.exec(req.url ?? '')
      req.resume()
      if (m && req.method === 'POST') {
        const status = EVENT_STATUS[m[2]]
        if (status) listener(decodeURIComponent(m[1]), status, m[2])
      }
      res.writeHead(204).end()
    })
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
    command: `curl -s -m 2 -X POST "http://127.0.0.1:\${FB_HOOK_PORT}/hook/\${FB_CONSOLE_ID}/${event}" -o /dev/null >/dev/null 2>&1 || true`
  })
  const hooks: Record<string, unknown[]> = {}
  for (const event of Object.keys(EVENT_STATUS)) {
    hooks[event] = [{ ...(event.endsWith('ToolUse') ? { matcher: '*' } : {}), hooks: [cmd(event)] }]
  }
  writeJsonAtomic(settingsFile(), { hooks })
}

export const hookEnv = (_id: string): Record<string, string> => (port ? { FB_HOOK_PORT: String(port) } : {})
export const claudeHookArgs = (_id: string): string[] => (port ? ['--settings', settingsFile()] : [])
