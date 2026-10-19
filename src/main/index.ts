import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, webContents } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { MainContext } from './context'
import { PtyManager } from './pty'
import { startHookServer } from './hooks'
import * as store from './store'
import * as fsops from './fsops'
import * as cli from './cli'
import * as agents from './agents'
import * as git from './git'
import * as usage from './usage'
import * as profiles from './profiles'
import * as sweep from './sweep'
import * as ci from './ci'
import * as goal from './goal'
import { initFleet } from './fleet'
import * as remote from './remote'
import { dirs } from './paths'
import { catchStrayErrors, logError } from './errors'
import { endOrphans } from './orphans'

let win: BrowserWindow | null = null

/** The session web tiles browse in (WebNode's <webview partition>). */
const WEB_PARTITION = 'persist:fleetboard-web'
const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])
function webPermission(permission: string, url: string | undefined) {
  if (HARMLESS.has(permission)) return true
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url ?? '').hostname)
  } catch {
    return false
  }
}

// Whatever the renderer asks for, a web tile never gets Node, a preload or an unsandboxed process.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, prefs) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
  })
})
let quitConfirmed = false
/** the window was reloaded after its page crashed; the new page says so once */
let crashRecovered = false

// On-device voice (Whisper, Kokoro) runs on the GPU through WebGPU; on Linux Chromium only exposes it
// with these flags (Vulkan backend). Without an adapter the models fall back to slower CPU wasm.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer,Vulkan')
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.setName('Fleetboard')
// fbfile:///abs/path serves local files (images, PDFs) to the renderer, which runs on http in dev.
protocol.registerSchemesAsPrivileged([{ scheme: 'fbfile', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])

// Output can still arrive while the window is being torn down; never touch a destroyed one.
const liveContents = () => (win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null)
const ptys = new PtyManager(liveContents, store.getSettings)
const ctx: MainContext = {
  ipc: ipcMain,
  win: () => win,
  ptys,
  settings: store.getSettings,
  emit: (channel, ...args) => {
    liveContents()?.send(channel, ...args)
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0b0a',
    frame: false,
    title: 'Fleetboard',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true,
      spellcheck: false,
      // loops, status and timers must keep running when the window is hidden
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // only web and mail links leave the app; other schemes could start arbitrary handlers
    if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Never let a stray link navigate the app window away; open it in the browser instead.
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  // The window's page died (out of memory, a GPU fault): the consoles live on in this process, and a new
  // page picks them up again like a reopened board. Repeated crashes are not retried forever.
  const crashes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return
    const now = Date.now()
    crashes.push(now)
    while (now - crashes[0] > 60_000) crashes.shift()
    console.error(`window crashed (${details.reason}, exit ${details.exitCode})`)
    if (crashes.length > 3) {
      // not showErrorBox: it would hold up this process, and with it every console's output
      void dialog.showMessageBox({
        type: 'error',
        title: 'Fleetboard keeps crashing',
        message: `The window crashed ${crashes.length} times in a minute (${details.reason}).`,
        detail: 'Your consoles are still running. Restart Fleetboard to see them again.'
      })
      return
    }
    crashRecovered = true
    win.webContents.reload()
  })
  win.on('closed', () => {
    win = null
  })
  win.on('close', (e) => {
    if (quitConfirmed || ptys.size === 0) return
    e.preventDefault()
    ctx.emit('app:confirmQuit', ptys.size)
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function registerCore() {
  ipcMain.handle('pty:spawn', (_e, req) => ptys.spawn(req))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:paste', (_e, id: string, text: string, submit: boolean) => ptys.send(id, String(text), submit))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.handle('pty:pause', (_e, id: string) => ptys.pause(id))
  ipcMain.handle('pty:resume', (_e, id: string) => ptys.resume(id))
  ipcMain.handle('pty:buffer', (_e, id: string) => ptys.buffer(id))
  ipcMain.handle('pty:tail', (_e, id: string, chars?: number) => ptys.tail(id, chars))
  ipcMain.handle('pty:prompt', (_e, id: string) => ptys.screen(id)?.prompt ?? null)
  ipcMain.handle('pty:answer', (_e, id: string, answer) => ptys.answer(id, answer))
  ipcMain.handle('pty:deliver', (_e, id: string, text: string) => ptys.deliver(id, String(text)))
  ipcMain.handle('pty:list', () => ptys.list())

  ipcMain.handle('app:quit', async () => {
    quitConfirmed = true
    await ptys.dispose()
    // the board is already saved; don't let a slow child process keep the app alive
    win?.destroy()
    win = null
    setTimeout(() => app.exit(0), 300)
  })
  // asked once by a page as it starts: was it reloaded after the window crashed?
  ipcMain.handle('app:crashRecovered', () => {
    const was = crashRecovered
    crashRecovered = false
    return was
  })
  ipcMain.handle('app:paths', () => ({ root: dirs.root, home: app.getPath('home'), assets: dirs.assets }))
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools())
  ipcMain.handle('webview:devtools', (_e, webContentsId: number) => {
    webContents.fromId(webContentsId)?.openDevTools({ mode: 'detach' })
  })

  // Render HTML to a real paginated PDF (document studio, markdown export).
  ipcMain.handle('pdf:fromHtml', async (_e, html: string, outPath: string) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    w.destroy()
    const fs = await import('node:fs')
    fs.writeFileSync(outPath, pdf)
    return outPath
  })
  ipcMain.handle('png:capture', async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    const img = await win!.webContents.capturePage(rect)
    return img.toPNG().toString('base64')
  })
}

// A separate state folder (FLEETBOARD_HOME) is a separate Fleetboard: give it its own Electron profile
// so it neither shares the single-instance lock nor the browser storage of the main app.
if (process.env.FLEETBOARD_HOME) app.setPath('userData', path.join(process.env.FLEETBOARD_HOME, 'electron'))

// One Fleetboard at a time: both would write the same ~/.fleetboard state. A second launch focuses this one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

catchStrayErrors((message) => ctx.emit('app:error', message))

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  protocol.handle('fbfile', (req) => net.fetch(pathToFileURL(decodeURIComponent(new URL(req.url).pathname)).toString()))
  // Microphone for push-to-talk; everything else stays denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-read' || permission === 'notifications'))
  // Web tiles: Electron grants every permission unless told otherwise. Sites get only harmless ones;
  // the user's own dev servers (localhost) get what they ask for, like in a browser they control.
  const web = session.fromPartition(WEB_PARTITION)
  web.setPermissionRequestHandler((_wc, permission, cb, details) => cb(webPermission(permission, details.requestingUrl)))
  web.setPermissionCheckHandler((_wc, permission, origin) => webPermission(permission, origin))
  // before any console starts: what a run that died left running would otherwise work on unseen
  const orphans = await endOrphans().catch(() => 0)
  if (orphans) logError('startup', new Error(`stopped ${orphans} console process${orphans === 1 ? '' : 'es'} the last run left running`))
  await startHookServer((id, event, payload) => ptys.hook(id, event, payload))
  registerCore()
  for (const m of [store, fsops, cli, agents, git, usage, profiles, goal, ci]) m.register(ctx)
  sweep.register(ctx)
  await initFleet(ctx)
  await remote.register(ctx)
  createWindow()
})

app.on('window-all-closed', async () => {
  await ptys.dispose()
  app.quit()
})
