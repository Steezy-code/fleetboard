// `npm test`: every unit test, on any OS. On Windows the ones that drive POSIX processes directly
// (/bin/sh fakes, process groups, /proc) are left out; test/e2e/windows.test.ts covers that ground there.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const POSIX_ONLY = new Set(['orphans', 'pty-enter-race', 'pty-dispose', 'goal-check', 'cli-run', 'pty-send', 'write-text', 'stray-children'])
const dir = path.join('test', 'unit')
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => process.platform !== 'win32' || !POSIX_ONLY.has(f.replace(/\.test\.ts$/, '')))
  .sort()
  .map((f) => path.join(dir, f))
const r = spawnSync(process.execPath, ['--enable-source-maps', '--import', './test/support/register.mjs', '--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
