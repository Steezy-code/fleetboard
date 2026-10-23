import { execFile } from 'node:child_process'
import path from 'node:path'
import { loginEnv } from './env'
import { dirs } from './paths'

// One way to run a child process, and one answer to what git's environment and arguments must be.
//
// There were four copies of the never-reject exec wrapper (git, sweep, ci, fleet) with three result
// shapes, and their git hardening had drifted: the sweep blocked every prompt, the git drawer blocked
// four of them, and fleet blocked one — while parsing --numstat output that LC_ALL=C exists to keep
// stable. Worse, a repo's own .git/config can name commands for git to run, and only one of the three
// places that produce a patch passed --no-ext-diff. Both are the same mistake: a decision taken at
// each call site instead of once.

export interface RunOut {
  code: number
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd: string
  env: Record<string, string>
  timeout?: number
  maxBuffer?: number
  /** written to stdin and closed (a commit message, so it never reaches a command line) */
  input?: string
}

/**
 * Run a command and resolve with what it did. Never rejects: every caller here wants the exit code,
 * and a non-zero exit is an answer rather than an exception. A failure with nothing on stderr still
 * gets a sentence, because "it failed" with an empty message is what makes these undiagnosable.
 */
export function run(bin: string, args: string[], opts: RunOpts): Promise<RunOut> {
  const { cwd, env, timeout = 20_000, maxBuffer = 16 * 1024 * 1024, input } = opts
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, env, timeout, maxBuffer }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      let se = String(stderr ?? '')
      if (err && !se.trim() && !String(stdout ?? '').trim()) {
        const name = path.basename(bin)
        se = err.killed ? `${name} timed out` : err.code === 'ENOENT' ? `${name} is not installed` : String(err.message ?? err)
      }
      resolve({ code, stdout: String(stdout ?? ''), stderr: se })
    })
    if (input != null) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

let gitCache: Record<string, string> | null = null
/**
 * git's environment. Nothing may prompt (a prompt in a child of the main process is a hang nobody
 * can see), nothing may localise its output (it is parsed), nothing may page it.
 */
export async function gitEnv(): Promise<Record<string, string>> {
  if (gitCache) return gitCache
  const env: Record<string, string> = {
    ...(await loginEnv()),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    GIT_PAGER: 'cat',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: ''
  }
  // and ssh must not wait for a host key or a passphrase either
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=6'
  gitCache = env
  return env
}

let ghCache: Record<string, string> | null = null
/** gh's environment: no prompts, no update notice, no spinner, no colour. */
export async function ghEnv(): Promise<Record<string, string>> {
  ghCache ??= {
    ...(await loginEnv()),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
  }
  return ghCache
}

/**
 * Options given to git itself, before any subcommand.
 *
 * `core.fsmonitor` names a program that `git status` runs, and it is read from the repository's own
 * .git/config — so a repo can turn "git status" into "run this". The app runs git in repos the user
 * never vetted: the morning sweep walks whole directory trees, and an agent that may edit files but
 * not run commands can write .git/config. This is not the user's own shell, where their config is
 * their business; here it is input.
 */
export const GIT_OPTS = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false']

/**
 * Config keys a repository can set to name a program that the sweep's own git calls (status, log,
 * an opt-in fetch) could run. core.fsmonitor and log.showSignature are switched off for every call
 * above, the pager is cat (gitEnv), and the sweep points hooks at an empty folder; these are the rest.
 */
const NAMES_A_PROGRAM = /^(filter\..+\.(clean|smudge|process)|credential\.(.+\.)?helper|core\.(sshcommand|gitproxy|askpass)|remote\..+\.(uploadpack|receivepack|vcs)|protocol\..+\.allow|uploadpack\.packobjectshook)$/i

/** Filters a repository may name without being suspect: tools the user installed for exactly this. */
const KNOWN_FILTER = /^"?git[- ](lfs|crypt)"?(\s|$)/i

/**
 * The keys in a repository's own config (with what it includes) that would have git run a program
 * the repository chose. Reading config runs nothing, so a repo the user never opened is read before
 * anything else is done in it. Its own is every scope but the user's (global) and the machine's
 * (system): .git/config, and .git/config.worktree, which git reads too once extensions.worktreeConfig
 * is set, and which `--local` leaves out.
 */
export async function programsInRepoConfig(cwd: string): Promise<string[]> {
  const env = await gitEnv()
  const r = await run('git', [...GIT_OPTS, 'config', '--includes', '--list', '--show-scope', '-z'], { cwd, env, timeout: 5000 })
  if (r.code !== 0) return []
  const found: string[] = []
  // -z with --show-scope: scope NUL key LF value NUL
  const parts = r.stdout.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!/^(local|worktree)$/.test(parts[i]!)) continue
    const entry = parts[i + 1]!
    const nl = entry.indexOf('\n')
    const key = nl < 0 ? entry : entry.slice(0, nl)
    const value = nl < 0 ? '' : entry.slice(nl + 1)
    if (!key || !value.trim() || !NAMES_A_PROGRAM.test(key)) continue
    if (/^filter\./i.test(key) && KNOWN_FILTER.test(value.trim())) continue
    found.push(key)
  }
  return found
}

/**
 * For git calls the app makes on its own behalf, where a repository's hooks must not run: hooks are
 * programs, and with husky or lefthook they live in tracked files that an agent allowed to edit files
 * (but not to run commands) can change. An empty folder as the hooks path, since `--no-verify` covers
 * only the commit hooks and not post-checkout, post-merge or reference-transaction.
 */
export const NO_HOOKS = ['-c', `core.hooksPath=${dirs.noHooks}`]

/** Options for a git call. `gitOpts` go before the subcommand, where git wants them. */
export interface GitOpts {
  timeout?: number
  input?: string
  maxBuffer?: number
  gitOpts?: string[]
}

/**
 * Subcommands that take diff options — the ones where a repository's own diff drivers would run.
 *
 * `diff.external` and a textconv driver are commands named in the repository's config, and git runs
 * them once per changed file while building a patch. So viewing a commit or a team's diff was enough
 * to execute them. --no-ext-diff and --no-textconv are what refuses that, and they are added here
 * rather than at each call site because the call site forgot: of the three places that produced a
 * patch, one passed --no-ext-diff and two did not.
 */
const DIFFS = new Set(['diff', 'show', 'log', 'format-patch', 'diff-tree', 'diff-index', 'diff-files', 'range-diff', 'whatchanged'])

/** The only way this app runs git. */
export function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<RunOut> {
  const { gitOpts = [], ...rest } = opts
  const [sub, ...tail] = args
  const hardened = sub !== undefined && DIFFS.has(sub) ? [sub, '--no-ext-diff', '--no-textconv', ...tail] : args
  return gitEnv().then((env) => run('git', [...GIT_OPTS, ...gitOpts, ...hardened], { cwd, env, ...rest }))
}
