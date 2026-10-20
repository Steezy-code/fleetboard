import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirs, writeJsonAtomic } from './paths'
import { homeOf, linkPath } from './platform'

// Gemini CLI takes MCP servers only from its settings files, so a team console gets a Gemini home of
// its own (GEMINI_CLI_HOME): every entry of the user's ~/.gemini linked in (sign-in, trusted folders,
// sessions), and a settings.json that is the user's plus the fleet server. The process's HOME is not
// changed, so commands it runs see the user's home as usual.

const realGeminiDir = (env: Record<string, string | undefined>) => path.join(env.GEMINI_CLI_HOME || homeOf(env), '.gemini')

/** JSON with // and /* comments (Gemini's settings allow them); null when it is not that. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      // copy a string, escapes included
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += c
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The home a team console's Gemini CLI runs under (GEMINI_CLI_HOME), with the fleet server in its settings. */
export function geminiTeamHome(memberId: string, server: { url: string; token: string }, env: Record<string, string | undefined>): string {
  const real = realGeminiDir(env)
  const home = path.join(dirs.root, 'gemini-homes', memberId.replace(/[^\w-]/g, '_'))
  const dot = path.join(home, '.gemini')
  fs.mkdirSync(dot, { recursive: true, mode: 0o700 })
  let entries: string[] = []
  try {
    entries = fs.readdirSync(real)
  } catch {
    /* Gemini never ran here: it starts from scratch in this home */
  }
  for (const name of entries) {
    if (name === 'settings.json') continue
    const link = path.join(dot, name)
    if (fs.lstatSync(link, { throwIfNoEntry: false })) continue
    try {
      linkPath(path.join(real, name), link)
    } catch {
      /* not linked: Gemini makes its own */
    }
  }
  let settings: Record<string, any> = {}
  try {
    const parsed = parseJsonc(fs.readFileSync(path.join(real, 'settings.json'), 'utf8'))
    if (isObj(parsed)) settings = parsed
  } catch {
    /* no settings of the user's */
  }
  settings.mcpServers = {
    ...(isObj(settings.mcpServers) ? settings.mcpServers : {}),
    // its own server: its tools never ask the user (Claude Code: --allowedTools mcp__fleet)
    fleet: { httpUrl: server.url, headers: { Authorization: `Bearer ${server.token}` }, trust: true, timeout: 600_000 }
  }
  writeJsonAtomic(path.join(dot, 'settings.json'), settings, 0o600)
  return home
}

export function removeGeminiTeamHome(memberId: string) {
  fs.rmSync(path.join(dirs.root, 'gemini-homes', memberId.replace(/[^\w-]/g, '_')), { recursive: true, force: true })
}

/** Whether the user trusts this folder (or a parent of it) in Gemini CLI. */
export function geminiTrusts(folder: string, env: Record<string, string | undefined>): boolean {
  let rules: unknown
  try {
    rules = parseJsonc(fs.readFileSync(path.join(realGeminiDir(env), 'trustedFolders.json'), 'utf8'))
  } catch {
    return false
  }
  if (!isObj(rules)) return false
  const target = path.resolve(folder)
  const within = (dir: string) => target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
  let verdict: boolean | undefined
  let best = -1
  for (const [p, rule] of Object.entries(rules)) {
    const dir = path.resolve(p)
    // TRUST_PARENT trusts the folder that contains the one listed
    const scope = rule === 'TRUST_PARENT' ? path.dirname(dir) : dir
    if (!within(scope) || scope.length <= best) continue
    best = scope.length
    verdict = rule === 'TRUST_FOLDER' || rule === 'TRUST_PARENT'
  }
  return verdict === true
}
