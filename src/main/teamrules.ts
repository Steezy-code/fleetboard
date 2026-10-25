import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readRegularFile } from './paths'

// What a team rule (renderer fleet/teamRules.ts) is bound to besides its command.
//
// A rule matches a command's text, and `npm test` is whatever package.json says it is. Workers edit
// files freely, so without this a worker could rewrite the "test" script and every later `npm test`
// would be answered for the team by the yes the user gave to the old one. The rule therefore carries a
// fingerprint of the files that define such commands, taken where the user said yes; each later answer
// takes it again in the asking console's own folder, and a difference means the user is asked again.
//
// Honest about the residue: `npm test` also runs the tests, which workers write too. That is what
// allowing a team to run its tests means, and the card says which command it is. What this stops is
// the command itself turning into something else under a yes that was given to it.

/** Files at a project's top level that decide what a test, check or build command runs. */
const DEFINES = [
  'package.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'deno.json',
  'deno.jsonc',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  'Taskfile.yml',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'tox.ini',
  'noxfile.py',
  'pytest.ini',
  'conftest.py',
  'Cargo.toml',
  '.cargo/config.toml',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'tsconfig.json'
]
/** and the runners' own config files, whatever their extension */
const RUNNER_CONFIG = /^(vitest|vite|jest|playwright|webpack|rollup|babel|karma|mocha|ava|cypress|eslint|tsup|turbo|nx)\.config\.[cm]?[jt]s$|^\.mocharc(\.[a-z]+)?$|^\.babelrc(\.[a-z]+)?$|^(turbo|nx|lerna)\.json$/

/** The most of any one file that is read: a definition file is small, and a huge one is read as its size alone. */
const MAX_FILE = 1024 * 1024

/**
 * One string for the definition files in `cwd` as they are now: which exist, and what they hold.
 * Null when the folder cannot be read, so a rule is never taken to match a folder nobody looked at.
 */
export function definitionFingerprint(cwd: string): string | null {
  let names: string[]
  try {
    if (!fs.statSync(cwd).isDirectory()) return null
    names = fs.readdirSync(cwd).filter((n) => RUNNER_CONFIG.test(n))
  } catch {
    return null
  }
  const hash = crypto.createHash('sha256')
  for (const name of [...new Set([...DEFINES, ...names])].sort()) {
    let body: Buffer | string
    try {
      body = readRegularFile(path.join(cwd, name), MAX_FILE)
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') continue
      // there but not readable as a file (too big, a FIFO, no permission): its state still counts
      body = `unreadable:${e?.code ?? e?.message ?? 'error'}`
    }
    hash.update(name).update('\0').update(String(Buffer.byteLength(body))).update('\0').update(body).update('\0')
  }
  return hash.digest('hex')
}
