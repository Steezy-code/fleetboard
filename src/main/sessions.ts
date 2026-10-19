import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Each Claude Code / Gemini CLI console gets its own conversation id, so reopening the board resumes
// that console's conversation. The CLIs' own "continue" picks the most recent conversation in the
// folder, and a board usually has several consoles in one folder: they would all resume the same one.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validSessionId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id)
export const newSessionId = () => crypto.randomUUID()

/**
 * Whether the CLI has saved a conversation under this id (it does once something was said). Resuming
 * an id it never saved fails, and so does starting a new conversation under an id it already has.
 */
export function hasTranscript(agentId: string, id: string, env: Record<string, string | undefined>): boolean {
  if (!validSessionId(id)) return false
  const home = env.HOME || os.homedir()
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p)
    } catch {
      return []
    }
  }
  if (agentId === 'claude') {
    // <config>/projects/<the cwd, encoded>/<id>.jsonl
    const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects')
    return dirs(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`)))
  }
  if (agentId === 'gemini') {
    // ~/.gemini/tmp/<project>/chats/session-<time>-<first 8 of the id>.json(l), which records the full id
    const root = path.join(home, '.gemini', 'tmp')
    for (const d of dirs(root)) {
      const chats = path.join(root, d, 'chats')
      for (const f of dirs(chats)) {
        if (!f.includes(id.slice(0, 8))) continue
        try {
          if (fs.readFileSync(path.join(chats, f), 'utf8').includes(id)) return true
        } catch {
          /* unreadable */
        }
      }
    }
  }
  return false
}
