import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const one = args.includes('--one')
const benchmark = args.includes('--benchmark')
const files = args.filter((a) => a !== '--one' && a !== '--benchmark')
const run = (file, argv, opts = {}) => {
  const r = spawnSync(file, argv, { stdio: 'inherit', ...opts })
  if (r.error) { console.error(r.error.message); process.exit(1) }
  if (r.status !== 0) process.exit(r.status ?? 1)
}
if (!one) run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.test.ts') ? [path.join(dir, e.name)] : [])
const chosen = files.length ? files : benchmark ? ['test/e2e/performance.test.ts'] : walk('test/e2e')
const argv = ['--enable-source-maps', '--import', './test/support/register.mjs', '--test', `--test-concurrency=${one || benchmark ? 1 : process.env.FB_E2E_JOBS || 1}`, ...chosen]
const env = { ...process.env, ...(benchmark ? { FB_BENCH: '1' } : {}) }
if (process.platform === 'win32' || process.env.FB_E2E_HEADLESS === '1') run(process.execPath, argv, { env })
else {
  // xvfb-run only sets DISPLAY: from a Wayland session Electron would still open every window on the
  // real desktop, so the Wayland variables go
  for (const k of ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT', 'OZONE_PLATFORM']) delete env[k]
  run('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, ...argv], { env })
}
