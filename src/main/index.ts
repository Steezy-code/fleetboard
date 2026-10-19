import { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell, webContents } from 'electron'
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
import { initFleet } from './fleet'
import { dirs } from './paths'

let win: BrowserWindow | null = null
let quitConfirmed = false

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
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // Never let a stray link navigate the app window away; open it in the browser instead.
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
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
  ipcMain.on('pty:paste', (_e, id: string, text: string, submit: boolean) => ptys.paste(id, text, submit))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.handle('pty:pause', (_e, id: string) => ptys.pause(id))
  ipcMain.handle('pty:resume', (_e, id: string) => ptys.resume(id))
  ipcMain.handle('pty:buffer', (_e, id: string) => ptys.buffer(id))
  ipcMain.handle('pty:tail', (_e, id: string, chars?: number) => ptys.tail(id, chars))
  ipcMain.handle('pty:list', () => ptys.list())

  ipcMain.handle('app:quit', () => {
    quitConfirmed = true
    ptys.dispose()
    // the board is already saved; don't let a slow child process keep the app alive
    win?.destroy()
    win = null
    setTimeout(() => app.exit(0), 300)
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  protocol.handle('fbfile', (req) => net.fetch(pathToFileURL(decodeURIComponent(new URL(req.url).pathname)).toString()))
  // Microphone for push-to-talk; everything else stays denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-read'))
  await startHookServer((id, status, event) => ptys.hook(id, status, event))
  registerCore()
  for (const m of [store, fsops, cli, agents, git, usage, profiles]) m.register(ctx)
  sweep.register(ctx)
  await initFleet(ctx)
  createWindow()
})

app.on('window-all-closed', () => {
  ptys.dispose()
  app.quit()
})
