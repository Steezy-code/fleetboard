import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { Profile } from '@shared/types'
import { agentById } from '@shared/agents'
import type { MainContext } from './context'
import { dirs, readJson, writeJsonAtomic } from './paths'
import { registerSkills } from './skills'

// Profiles: several accounts of one CLI side by side. Each profile is its own config dir
// (~/.fleetboard/profiles/<id>/) handed to the CLI through its config env var
// (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex). The default sign-in is untouched.

export interface ProfileInfo extends Profile {
  signedIn: boolean
  account?: string
}

export interface DefaultSignIn {
  agentId: string
  dir: string
  signedIn: boolean
  account?: string
}

const indexFile = path.join(dirs.profiles, 'index.json')

export function listProfiles(): Profile[] {
  const list = readJson<Profile[]>(indexFile, [])
  return Array.isArray(list) ? list : []
}
const saveProfiles = (list: Profile[]) => writeJsonAtomic(indexFile, list)

/** Env vars that point a CLI at a profile's config dir. Empty for the default sign-in. */
export function profileEnv(agentId: string, profileId?: string): Record<string, string> {
  if (!profileId) return {}
  const p = listProfiles().find((x) => x.id === profileId)
  if (!p) return {}
  const env = agentById(p.agentId)?.configEnv ?? agentById(agentId)?.configEnv
  if (!env) return {}
  fs.mkdirSync(p.dir, { recursive: true })
  return { [env]: p.dir }
}

const home = () => os.homedir()
const defaultDir = (agentId: string) => {
  if (agentId === 'claude') return process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude')
  if (agentId === 'codex') return process.env.CODEX_HOME || path.join(home(), '.codex')
  return path.join(home(), `.${agentId}`)
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'profile'
  )
}

function newId(agentId: string, name: string, list: Profile[]) {
  const base = `${agentId}-${slug(name)}`
  let id = base
  for (let i = 2; list.some((p) => p.id === id) || fs.existsSync(path.join(dirs.profiles, id)); i++) id = `${base}-${i}`
  return id
}

function decodeJwtEmail(token: unknown): string | undefined {
  if (typeof token !== 'string') return
  // a token with no dots in it has no payload segment; it reached Buffer.from as undefined and the
  // catch below turned that into the same answer, which is right but only by accident
  const [, payload64] = token.split('.')
  if (!payload64) return
  try {
    const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8'))
    return payload.email ?? payload['https://api.openai.com/profile']?.email
  } catch {
    return
  }
}

/** Who a config dir is signed in as, read from the CLI's own files (best effort). */
function inspect(agentId: string, dir: string, isDefault: boolean): { signedIn: boolean; account?: string } {
  if (agentId === 'claude') {
    // with CLAUDE_CONFIG_DIR the global config lives inside the dir; by default it is ~/.claude.json
    const cfgFile = isDefault && !process.env.CLAUDE_CONFIG_DIR ? path.join(home(), '.claude.json') : path.join(dir, '.claude.json')
    const cfg = readJson<any>(cfgFile, null)
    const acct = cfg?.oauthAccount
    const creds = fs.existsSync(path.join(dir, '.credentials.json'))
    const account = acct?.emailAddress ? `${acct.emailAddress}${acct.organizationName ? ` · ${acct.organizationName}` : ''}` : undefined
    return { signedIn: creds || !!acct || !!cfg?.primaryApiKey, account }
  }
  if (agentId === 'codex') {
    const auth = readJson<any>(path.join(dir, 'auth.json'), null)
    if (!auth) return { signedIn: false }
    const email = decodeJwtEmail(auth?.tokens?.id_token)
    return { signedIn: !!(auth.tokens || auth.OPENAI_API_KEY), account: email ?? (auth.OPENAI_API_KEY ? 'API key' : undefined) }
  }
  return { signedIn: fs.existsSync(dir) && fs.readdirSync(dir).length > 0 }
}

function copyIfExists(from: string, to: string, copied: string[]) {
  try {
    if (!fs.existsSync(from)) return
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    fs.chmodSync(to, 0o600)
    copied.push(path.basename(from))
  } catch {
    /* skip unreadable */
  }
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  registerSkills(ctx)

  ipc.handle('profiles:list', (_e, agentId?: string): ProfileInfo[] =>
    listProfiles()
      .filter((p) => !agentId || p.agentId === agentId)
      .map((p) => ({ ...p, ...inspect(p.agentId, p.dir, false) }))
  )

  ipc.handle('profiles:default', (_e, agentId: string): DefaultSignIn => {
    const dir = defaultDir(agentId)
    return { agentId, dir, ...inspect(agentId, dir, true) }
  })

  ipc.handle('profiles:create', (_e, agentId: string, name: string): Profile => {
    const list = listProfiles()
    const clean = (name || '').trim() || 'Profile'
    const id = newId(agentId, clean, list)
    const dir = path.join(dirs.profiles, id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const p: Profile = { id, agentId, name: clean, dir, createdAt: Date.now() }
    saveProfiles([...list, p])
    return p
  })

  /** Copy the current default sign-in into a new profile so it can be used side by side. */
  ipc.handle('profiles:saveCurrent', (_e, agentId: string, name: string): { profile: Profile; copied: string[] } => {
    const list = listProfiles()
    const src = defaultDir(agentId)
    const def = inspect(agentId, src, true)
    const clean = (name || '').trim() || def.account?.split(' · ')[0] || 'My sign-in'
    const id = newId(agentId, clean, list)
    const dir = path.join(dirs.profiles, id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const copied: string[] = []
    if (agentId === 'claude') {
      copyIfExists(path.join(src, '.credentials.json'), path.join(dir, '.credentials.json'), copied)
      const cfg = process.env.CLAUDE_CONFIG_DIR ? path.join(src, '.claude.json') : path.join(home(), '.claude.json')
      copyIfExists(cfg, path.join(dir, '.claude.json'), copied)
      copyIfExists(path.join(src, 'settings.json'), path.join(dir, 'settings.json'), copied)
    } else if (agentId === 'codex') {
      copyIfExists(path.join(src, 'auth.json'), path.join(dir, 'auth.json'), copied)
      copyIfExists(path.join(src, 'config.toml'), path.join(dir, 'config.toml'), copied)
    }
    const p: Profile = { id, agentId, name: clean, dir, createdAt: Date.now() }
    saveProfiles([...list, p])
    return { profile: p, copied }
  })

  ipc.handle('profiles:rename', (_e, id: string, name: string) => {
    const clean = (name || '').trim()
    if (!clean) return listProfiles()
    const list = listProfiles().map((p) => (p.id === id ? { ...p, name: clean } : p))
    saveProfiles(list)
    return list
  })

  ipc.handle('profiles:delete', (_e, id: string) => {
    const list = listProfiles()
    const p = list.find((x) => x.id === id)
    saveProfiles(list.filter((x) => x.id !== id))
    // only ever remove dirs we created inside ~/.fleetboard/profiles
    if (p && path.resolve(p.dir).startsWith(path.resolve(dirs.profiles) + path.sep)) fs.rmSync(p.dir, { recursive: true, force: true })
    return true
  })

  ipc.handle('profiles:open', (_e, id?: string) => {
    const p = id ? listProfiles().find((x) => x.id === id) : null
    const dir = p?.dir ?? dirs.profiles
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  })
}
