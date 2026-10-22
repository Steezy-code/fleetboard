// After `npm install`: build node-pty for this Electron. Windows (and macOS) use node-pty's own
// prebuilt N-API binaries, which work in Electron as they are, so no compiler toolchain is needed there.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

// Electron's package has no install script: it downloads the binary the first time something calls
// require('electron'), and returns the path. Left to itself that first time is whoever reaches for it
// — and the end-to-end suite runs several test processes at once, which means several of them
// extracting into the same folder and corrupting it. Here it happens once, at install time, which is
// where it belongs.
try {
  console.log(`electron: ${require('electron')}`)
} catch (e) {
  console.error(`could not install Electron: ${e.message}`)
  process.exit(1)
}

const ptyDir = path.dirname(require.resolve('node-pty/package.json'))
const prebuilt = existsSync(path.join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`))

if (process.platform !== 'linux' && prebuilt) {
  console.log(`node-pty: using its prebuilt ${process.platform}-${process.arch} binary`)
  process.exit(0)
}
const r = spawnSync('electron-rebuild', ['-f', '-w', 'node-pty'], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
