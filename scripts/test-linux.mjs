// `npm run test:linux`: the Linux half of the suite, from a Windows machine, in a container.
//
// Why it exists: 26 of the 28 end-to-end files and 8 of the unit files never run on Windows (POSIX
// process groups, /proc, FIFOs, symlinks), so developing here means the Linux gate is only ever CI's.
// This is the same ground, one command, without waiting for a pull request.
//
// It is not a replacement for CI: Debian with the GTK libraries installed by hand is close to
// ubuntu-24.04, not identical. It is for catching the obvious before pushing.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const WHAT = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['unit', 'e2e'])
const root = path.resolve(import.meta.dirname, '..')

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? ''
const head = git('rev-parse', 'HEAD')
if (!head) {
  console.error('not a git repository, or no commit yet')
  process.exit(1)
}
// the container clones from this repo, so only what is committed is tested
if (git('status', '--porcelain')) console.log('note: uncommitted changes are NOT included — commit first to test them\n')

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('Docker is not running. Start Docker Desktop (or the daemon) and try again.')
  process.exit(1)
}

// ubuntu-24.04 runners ship these; a node image does not. xvfb is what ci.yml installs for itself.
const E2E_DEPS =
  'xvfb libgtk-3-0 libnss3 libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 ' +
  'libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libnspr4 libxshmfence1'

// The repo is mounted read-only and cloned inside: this machine's node_modules holds node-pty built
// for Electron on Windows, and an npm ci over the top of it would leave nothing here that runs.
//
// ponytail: npm ci runs every time, which is most of the wall clock. Keep /work in a named volume and
// fetch into it instead if that starts to grate.
const script = [
  'set -e',
  "git config --global --add safe.directory '*'",
  ...(WHAT.has('e2e') ? ['export DEBIAN_FRONTEND=noninteractive', 'apt-get update -qq', `apt-get install -yqq ${E2E_DEPS} >/dev/null 2>&1`, "echo '--- Linux GUI libraries installed'"] : []),
  'git clone -q /host /work',
  'cd /work',
  `git checkout -q ${head}`,
  'npm ci >/dev/null 2>&1',
  "echo \"--- $(node --version), $(git log --oneline -1)\"",
  ...(WHAT.has('unit') ? ["echo '--- unit'", 'npm test'] : []),
  ...(WHAT.has('e2e') ? ["echo '--- end to end'", 'npm run test:e2e'] : [])
].join('\n')

const args = ['run', '--rm', '--init', '--shm-size=1g', '-v', `${root}:/host:ro`, '-e', 'CI=1']
if (process.env.FB_E2E_JOBS) args.push('-e', `FB_E2E_JOBS=${process.env.FB_E2E_JOBS}`)
args.push('node:22', 'bash', '-c', script)

console.log(`Linux checks (${[...WHAT].join(' + ')}) on ${head.slice(0, 8)} — the first run downloads node:22 and Electron\n`)
process.exit(spawnSync('docker', args, { stdio: 'inherit' }).status ?? 1)
