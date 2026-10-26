import fs from 'node:fs'
import path from 'node:path'
import type { MainContext } from './context'
import { type KnowledgeFact, type RepoReading, slug } from '@shared/knowledge'
import { readRegularText } from './paths'
import { allowedPath } from './roots'

// The free half of repo knowledge: what a repo's own files say about how it is checked, who owns what
// and its house style. No model and no shell — plain reads, the same on Linux and Windows — so it can
// run whenever its result is a few minutes old without costing the user anything. Everything here is
// `repo` provenance, which is why it reads only what a file states outright and leaves anything that
// needs judgement to the model pass (renderer/src/fleet/knowledge.ts).

/** A config or manifest is kilobytes; anything far past that is not one, and is not worth the read. */
const MAX_FILE = 256 * 1024
/** Scripts and targets that check the work. `dev` or `start` runs the app, which proves nothing. */
const CHECK = /^(test|lint|typecheck|type-check|tsc|build|check|format|fmt|verify)(:[\w:-]+)?$/
const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]
const STYLE: { key: string; text: string; files: string[] }[] = [
  { key: 'prettier', text: 'Formatting is Prettier’s', files: ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'] },
  { key: 'eslint', text: 'Linted with ESLint', files: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml'] },
  { key: 'oxlint', text: 'Linted with oxlint', files: ['.oxlintrc.json', 'oxlintrc.json'] },
  { key: 'biome', text: 'Formatted and linted with Biome', files: ['biome.json', 'biome.jsonc'] },
  { key: 'rustfmt', text: 'Rust is formatted with rustfmt', files: ['rustfmt.toml', '.rustfmt.toml'] },
  { key: 'ruff', text: 'Python is linted with Ruff', files: ['ruff.toml', '.ruff.toml'] }
]
const GUIDES: [string, string][] = [
  ['CLAUDE.md', 'House rules for agents are in CLAUDE.md'],
  ['AGENTS.md', 'House rules for agents are in AGENTS.md'],
  ['CONTRIBUTING.md', 'How to contribute is in CONTRIBUTING.md'],
  ['.github/CONTRIBUTING.md', 'How to contribute is in .github/CONTRIBUTING.md']
]

/** A small text file's contents, or null: missing, a folder, too big, or unreadable all mean the same here. */
function readText(file: string): string | null {
  try {
    return readRegularText(file, MAX_FILE)
  } catch {
    return null
  }
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Each source's findings on its own: one unreadable or malformed file costs its own facts, not the read. */
function attempt(f: () => void) {
  try {
    f()
  } catch {
    /* that file says nothing, then */
  }
}

/** What a repo's files say about it. Never throws: a folder that is not there, or says nothing, is no facts. */
export function readRepo(root: string, at: number = Date.now()): RepoReading {
  const facts: KnowledgeFact[] = []
  const docs: string[] = []
  const abs = (rel: string) => path.join(root, ...rel.split('/'))
  const exists = (rel: string) => fs.existsSync(abs(rel))
  const add = (f: Omit<KnowledgeFact, 'provenance' | 'at'>) => {
    if (!facts.some((x) => x.key === f.key)) facts.push({ ...f, provenance: 'repo', at })
  }
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return { facts, docs }
  }

  // ---- the readme and guides, for the model pass
  const readme = names.filter((n) => /^readme(\.(md|markdown|rst|txt))?$/i.test(n)).sort()[0]
  if (readme) docs.push(readme)
  for (const [file] of GUIDES) if (exists(file)) docs.push(file)

  // ---- checks
  const lock = LOCKFILES.find(([f]) => exists(f))
  const pm = lock?.[1] ?? 'npm'
  if (lock) add({ key: 'checks.package-manager', topic: 'checks', text: `Packages are managed with ${lock[1]}`, source: lock[0] })
  attempt(() => {
    const text = readText(abs('package.json'))
    if (text === null) return
    const pkg = JSON.parse(text)
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {}
    let n = 0
    for (const [name, body] of Object.entries(scripts)) {
      if (!CHECK.test(name) || typeof body !== 'string' || n++ >= 12) continue
      // `npm test` and `pnpm test` are what people type; every other script needs `run`. bun's own
      // `bun test` is its test runner rather than the script, so bun always says `run`.
      const command = name === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${name}`
      add({ key: `checks.${slug(name)}`, topic: 'checks', text: `\`${command}\` runs ${clip(body, 120)}`, source: 'package.json', command })
    }
    if (pkg && pkg.prettier) add({ key: 'style.prettier', topic: 'style', text: 'Formatting is Prettier’s', source: 'package.json' })
  })
  attempt(() => {
    const text = readText(abs('Makefile'))
    if (text === null) return
    const targets = [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]!).filter((t) => CHECK.test(t))
    for (const t of [...new Set(targets)].slice(0, 8)) add({ key: `checks.make-${slug(t)}`, topic: 'checks', text: `\`make ${t}\` is a Makefile target`, source: 'Makefile', command: `make ${t}` })
  })
  if (exists('Cargo.toml')) add({ key: 'checks.cargo-test', topic: 'checks', text: 'A Rust crate: `cargo test` runs its tests', source: 'Cargo.toml', command: 'cargo test' })
  if (exists('go.mod')) add({ key: 'checks.go-test', topic: 'checks', text: 'A Go module: `go test ./...` runs its tests', source: 'go.mod', command: 'go test ./...' })
  attempt(() => {
    const text = readText(abs('pyproject.toml'))
    if (text === null) return
    if (/pytest/.test(text)) add({ key: 'checks.pytest', topic: 'checks', text: 'Python tests run with `pytest`', source: 'pyproject.toml', command: 'pytest' })
    if (/^\[tool\.ruff/m.test(text)) add({ key: 'style.ruff', topic: 'style', text: 'Python is linted with Ruff', source: 'pyproject.toml' })
    if (/^\[tool\.black/m.test(text)) add({ key: 'style.black', topic: 'style', text: 'Python is formatted with Black', source: 'pyproject.toml' })
  })
  attempt(() => {
    const dir = abs('.github/workflows')
    if (!isDir(dir)) return
    const flows = fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
    if (flows.length) add({ key: 'checks.ci', topic: 'checks', text: `CI runs on GitHub Actions: ${flows.slice(0, 8).join(', ')}`, source: '.github/workflows' })
  })
  if (exists('.gitlab-ci.yml')) add({ key: 'checks.ci', topic: 'checks', text: 'CI runs on GitLab CI', source: '.gitlab-ci.yml' })

  // ---- layout
  const testDirs = ['test', 'tests', '__tests__', 'spec'].filter((d) => names.includes(d) && isDir(abs(d)))
  if (testDirs.length) add({ key: 'layout.tests', topic: 'layout', text: `Tests live in ${testDirs.map((d) => `${d}/`).join(' and ')}`, source: `${testDirs[0]}/` })

  // ---- ownership
  attempt(() => {
    const file = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find(exists)
    const text = file ? readText(abs(file)) : null
    if (!file || text === null) return
    let n = 0
    for (const raw of text.split(/\r?\n/)) {
      const [pattern, ...owners] = raw.replace(/#.*/, '').trim().split(/\s+/)
      if (!pattern || !owners.length || n++ >= 12) continue
      const shown = pattern.replace(/^\/+/, '')
      const what = shown === '*' || !shown ? 'Everything' : shown
      add({ key: `ownership.${slug(shown) || 'everything'}`, topic: 'ownership', text: `${what} is owned by ${owners.join(', ')}`, source: file })
    }
  })

  // ---- style
  attempt(() => {
    const text = readText(abs('.editorconfig'))
    if (text === null) return
    // the [*] section is the house default; a section for one file type is an exception to it
    const all: Record<string, string> = {}
    let section = ''
    for (const l of text.split(/\r?\n/)) {
      // trim, then match: a pattern with \s* on both sides of a lazy middle backtracks over every
      // space in a long value, and a repo's .editorconfig is read on the main process as a board opens
      const t = l.trim()
      if (t.startsWith('[') && t.endsWith(']')) section = t.slice(1, -1).trim()
      const kv = /^([\w-]+)\s*=(.*)$/.exec(t)
      if (kv && section === '*') all[kv[1]!.toLowerCase()] = kv[2]!.trim().toLowerCase()
    }
    const style = all.indent_style
    const size = /^\d+$/.test(all.indent_size ?? '') ? all.indent_size : undefined
    if (style === 'tab') add({ key: 'style.indent', topic: 'style', text: 'Indent with tabs', source: '.editorconfig' })
    else if (style === 'space') add({ key: 'style.indent', topic: 'style', text: size ? `Indent with ${size} spaces` : 'Indent with spaces', source: '.editorconfig' })
  })
  for (const s of STYLE) {
    const file = s.files.find(exists)
    if (file) add({ key: `style.${s.key}`, topic: 'style', text: s.text, source: file })
  }
  attempt(() => {
    const text = readText(abs('tsconfig.json'))
    // matched rather than parsed: a tsconfig may hold comments and trailing commas, which JSON.parse refuses
    if (text !== null && /"strict"\s*:\s*true/.test(text)) add({ key: 'style.typescript-strict', topic: 'style', text: 'TypeScript runs in strict mode', source: 'tsconfig.json' })
  })
  for (const [file, text] of GUIDES) if (exists(file)) add({ key: `style.guide-${slug(file)}`, topic: 'style', text, source: file })

  return { facts, docs }
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function register(ctx: MainContext) {
  // The renderer names the folder; only one Fleetboard may read anyway is read on its say-so, as the
  // filesystem handlers do (roots.ts). Null, not an error: no knowledge is a state a goal works in.
  ctx.ipc.handle('knowledge:read', (_e, root: unknown) => {
    const abs = allowedPath(root, 'knowledge:read')
    return abs ? readRepo(abs) : null
  })
}
