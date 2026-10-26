import fs from 'node:fs'
import path from 'node:path'
import { dirs, writeJsonAtomic } from './paths'
import { homeOf, linkPath } from './platform'
import { parseJsonc } from './gemini-home'

// These CLIs discover MCP through their home directory. Never put a per-member token into a
// repository or the user's global config (reviewers can share the lead's worktree).
const profileDir = (agent: string, id: string) => {
  if (!['antigravity', 'freebuff'].includes(agent) || !/^[\w-]+$/.test(id)) throw new Error('Bad agent profile id')
  return path.join(dirs.root, 'agent-profiles', agent, id)
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
function read(file: string): Record<string, any> {
  try { const v = parseJsonc(fs.readFileSync(file, 'utf8')); if (object(v)) return v } catch { /* no config */ }
  return {}
}
function linkEntries(source: string, target: string, except: string[] = []) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(source)) return
  for (const name of fs.readdirSync(source)) {
    if (except.includes(name)) continue
    const dst = path.join(target, name)
    if (!fs.lstatSync(dst, { throwIfNoEntry: false })) linkPath(path.join(source, name), dst)
  }
}
export const READ_ONLY_DENY = ['write_file(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)', 'execute_url(*)', 'read_url(*)']

export function agentProfile(agent: 'antigravity' | 'freebuff', id: string, env: Record<string, string | undefined>, opts: { readOnly?: boolean; reviewOnly?: boolean; server?: { url: string; token: string } } = {}): Record<string, string> {
  const real = homeOf(env)
  const home = profileDir(agent, id)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  // Isolate the agent home without linking unrelated shell configuration or credentials.
  const out: Record<string, string> = { HOME: home, USERPROFILE: home }
  if (agent === 'freebuff') {
    // Credentials remain owned by the official CLI. Do not extract or repurpose its OAuth token.
    out.FREEBUFF_CONFIG_DIR = env.FREEBUFF_CONFIG_DIR || path.join(real, '.config', 'manicode')
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true, mode: 0o700 })
    const config = read(path.join(real, '.agents', 'mcp.json'))
    const servers = object(config.mcpServers) ? config.mcpServers : {}
    if (opts.server) servers.fleet = { type: 'http', url: opts.server.url, headers: { Authorization: 'Bearer ' + opts.server.token } }
    writeJsonAtomic(path.join(home, '.agents', 'mcp.json'), { ...config, mcpServers: servers }, 0o600)
    return out
  }
  const gemini = path.join(home, '.gemini')
  linkEntries(path.join(real, '.gemini'), gemini, ['config', 'antigravity-cli'])
  const configDir = path.join(gemini, 'config')
  linkEntries(path.join(real, '.gemini', 'config'), configDir, ['mcp_config.json'])
  const cliDir = path.join(gemini, 'antigravity-cli')
  linkEntries(path.join(real, '.gemini', 'antigravity-cli'), cliDir, ['settings.json', 'cache'])
  // Native print mode can reset onboarding.json. Seed each console from the user's
  // actual completed setup, but never let a planner or sibling overwrite that record.
  const realCache = path.join(real, '.gemini', 'antigravity-cli', 'cache')
  const cache = path.join(cliDir, 'cache')
  linkEntries(realCache, cache, ['onboarding.json'])
  const onboarding = path.join(realCache, 'onboarding.json')
  if (fs.existsSync(onboarding)) fs.copyFileSync(onboarding, path.join(cache, 'onboarding.json'))
  const settings = read(path.join(real, '.gemini', 'antigravity-cli', 'settings.json'))
  const mcp = read(path.join(real, '.gemini', 'config', 'mcp_config.json'))
  // Pick a stable terminal layout in Fleetboard when initial setup has not saved one yet.
  settings.colorScheme ??= 'terminal'
  settings.altScreenMode ??= 'always'
  if (opts.readOnly) {
    // Plan mode is an instruction prefix, not a permission boundary. Deny writes and all command,
    // browser-actuation and MCP routes, even when the user's settings normally allow them.
    settings.agentMode = 'plan'
    settings.toolPermission = 'request-review'
    delete settings.hooks
    const p = object(settings.permissions) ? settings.permissions : {}
    settings.permissions = { ...p, deny: [...(Array.isArray(p.deny) ? p.deny : []), ...READ_ONLY_DENY] }
    mcp.mcpServers = {}
  } else if (opts.server) {
    const p = object(settings.permissions) ? settings.permissions : {}
    settings.permissions = { ...p, allow: [...(Array.isArray(p.allow) ? p.allow : []), 'mcp(fleet/*)'], ...(opts.reviewOnly ? { deny: [...(Array.isArray(p.deny) ? p.deny : []), 'write_file(*)'] } : {}) }
    mcp.mcpServers = { ...(object(mcp.mcpServers) ? mcp.mcpServers : {}), fleet: { serverUrl: opts.server.url, headers: { Authorization: 'Bearer ' + opts.server.token } } }
  }
  writeJsonAtomic(path.join(cliDir, 'settings.json'), settings, 0o600)
  writeJsonAtomic(path.join(configDir, 'mcp_config.json'), mcp, 0o600)
  return out
}

export function removeAgentProfile(agent: string, id: string) {
  const home = profileDir(agent, id)
  // rm removes links/junctions themselves, never their targets.
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
