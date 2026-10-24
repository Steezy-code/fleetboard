// Is there a newer Fleetboard than the one running? One `gh release view` against this app's own
// repository — never the board's project, which is a different repo with its own releases — compared
// to the running version. Nothing is downloaded or installed: the installer is unsigned and the repo
// is private, so the honest end of this is a link the user opens while signed in to GitHub.
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { MainContext } from './context'
import { which } from './env'
import { ghEnv, run } from './run'

/** This app's own repository. Its identity, not a setting: electron-builder.yml hardcodes the rest of it. */
const REPO = 'Steezy-code/fleetboard'

/** Checked once per launch and kept: a release does not appear often enough to poll for. */
const CHECK_TIMEOUT_MS = 15_000

export interface Release {
  tag: string
  name: string
  /** the release page on github.com, or '' when gh gave none we would open */
  url: string
  publishedAt: string
  prerelease: boolean
}

export interface UpdateCheck {
  current: string
  latest: Release | null
  /** the release to offer: null when this build is the latest, or newer than it */
  newer: Release | null
  error?: string
}

const num = (s: string | undefined) => {
  const n = Number(s)
  return Number.isInteger(n) && n >= 0 ? n : -1
}

/** `v0.2.0-win.1` → its three numbers and the prerelease tail, or nulls when it is not a version at all. */
function parts(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim())
  if (!m) return null
  const nums = [num(m[1]), num(m[2]), num(m[3])]
  return nums.some((n) => n < 0) ? null : { nums, pre: m[4] ?? '' }
}

/**
 * Semver precedence, as far as this needs it: the numbers in order, then a prerelease below the
 * release it leads to, then prerelease tails compared piece by piece so `win.2` is after `win.1`.
 * Anything unparseable sorts below everything, so a junk tag never passes as an update.
 */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (!x.pre !== !y.pre) return x.pre ? -1 : 1
  if (!x.pre) return 0
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i]
    const q = ys[i]
    if (p === q) continue
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = num(p)
    const qn = num(q)
    if (pn >= 0 && qn >= 0) return pn - qn
    return p < q ? -1 : 1
  }
  return 0
}

/** What `gh release view --json …` printed. A tag is the one field it is no release without. */
export function parseRelease(stdout: string): Release | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '')
  const tag = str(r.tagName)
  if (!tag) return null
  const url = str(r.url)
  return {
    tag,
    name: str(r.name) || tag,
    // only a github.com page, so a url from anywhere else is never handed to the OS to open
    url: /^https:\/\/github\.com\//i.test(url) ? url : '',
    publishedAt: str(r.publishedAt),
    prerelease: r.isPrerelease === true
  }
}

/**
 * What `gh` exiting says about this build. A repository with no releases yet is not an error — there
 * is simply nothing to be behind — so it answers "no release", and only a real failure carries a
 * message the panel shows.
 */
export function interpret(current: string, r: { code: number; stdout: string; stderr: string }): UpdateCheck {
  if (r.code === 0) {
    const latest = parseRelease(r.stdout)
    return { current, latest, newer: newerRelease(current, latest) }
  }
  const msg = r.stderr.trim().split('\n')[0] ?? ''
  if (/release not found|no releases/i.test(msg)) return { current, latest: null, newer: null }
  if (/auth login|not logged/i.test(msg)) return { current, latest: null, newer: null, error: 'Sign in with `gh auth login` to check for a new version.' }
  return { current, latest: null, newer: null, error: msg || 'gh failed' }
}

/** The release worth telling the user about: one strictly newer than what they are running. */
export function newerRelease(current: string, latest: Release | null): Release | null {
  if (!latest) return null
  return compareVersions(latest.tag, current) > 0 ? latest : null
}

/**
 * Fleetboard's own version. `app.getVersion()` falls back to Electron's when it cannot find a
 * package.json beside the app — which is exactly how the end-to-end tests start it — and "Fleetboard
 * 44.9.0" is worse than no version at all, so the manifest is read where each way of starting puts it.
 */
export function runningVersion(): string {
  const root = app.getAppPath()
  for (const p of [path.join(root, 'package.json'), path.join(root, '..', '..', 'package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
      if (typeof v === 'string' && v) return v
    } catch {
      // the next candidate, then Electron's answer
    }
  }
  return app.getVersion()
}

export function register(ctx: MainContext) {
  let cached: UpdateCheck | null = null
  ctx.ipc.handle('update:check', async (_e, force?: boolean): Promise<UpdateCheck> => {
    const current = runningVersion()
    if (cached && !force) return cached
    const gh = await which('gh')
    if (!gh) return { current, latest: null, newer: null, error: 'Install the GitHub CLI (gh) to check for a new version.' }
    // --repo, so it asks about Fleetboard wherever it runs; home is just a folder that exists
    const r = await run(gh, ['release', 'view', '--repo', REPO, '--json', 'tagName,name,url,publishedAt,isPrerelease'], { cwd: app.getPath('home'), env: await ghEnv(), timeout: CHECK_TIMEOUT_MS })
    const out = interpret(current, r)
    // only a good answer is kept: a check that failed should run again, not stick for the session
    if (!out.error) cached = out
    return out
  })
}
