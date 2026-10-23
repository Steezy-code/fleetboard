import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell, webContents } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { MainContext } from './context'
import { PtyManager } from './pty'
import { describeAnswer } from '@shared/prompt'
import { startHookServer } from './hooks'
import * as store from './store'
import * as fsops from './fsops'
import * as cli from './cli'
import * as agents from './agents'
import * as git from './git'
import * as usage from './usage'
import * as profiles from './profiles'
import * as skills from './skills'
import * as sweep from './sweep'
import * as starter from './starter'
import * as ci from './ci'
import * as goal from './goal'
import * as knowledge from './knowledge'
import * as fleet from './fleet'
import { stopFleetTicks } from './fleet'
import * as remote from './remote'
import { dirs } from './paths'
import { THEMES, themeById, type Theme } from '@shared/themes'
import { toRendererPath } from './platform'
import { catchStrayErrors, logError } from './errors'
import { appPermission, mediaTypesOf, webPermission } from './permissions'
import * as journal from './journal'
import { allowed, outsideMessage } from './roots'
import { endOrphans } from './orphans'

let win: BrowserWindow | null = null

/** The session web tiles browse in (WebNode's <webview partition>). */
const WEB_PARTITION = 'persist:fleetboard-web'
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
/**
 * Cleared by app:quitAck. A page that answers the save-and-quit request gets as long as it needs
 * (the save, and the dialog if the save failed); one that cannot answer at all must not leave the
 * window unclosable.
 */
let quitWatchdog: ReturnType<typeof setTimeout> | undefined
const QUIT_ACK_MS = 2000
/** the window was reloaded after its page crashed; the new page says so once */
let crashRecovered = false

// On-device voice (Whisper, Kokoro) runs on the GPU through WebGPU; on Linux Chromium only exposes it
// with these flags (Vulkan backend). Without an adapter the models fall back to slower CPU wasm.
// Windows and macOS have WebGPU on by default (D3D12 / Metal).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer,Vulkan')
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
} else app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
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

/** Windows title-bar buttons: same height as the top bar, colored like the theme. */
const overlayFor = (t: Theme) => ({ color: t.tokens.bg, symbolColor: t.tokens.muted, height: 46 })

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: themeById(store.getSettings().theme).tokens.bg,
    frame: false,
    // Windows: the system's own minimize / maximize / close (with Snap Layouts), in the theme's colors
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: overlayFor(themeById(store.getSettings().theme)) } : {}),
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
    while ((crashes[0] ?? Infinity) < now - 60_000) crashes.shift()
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
    if (quitConfirmed) return
    e.preventDefault()
    if (ptys.size) return ctx.emit('app:confirmQuit', ptys.size)
    // No console to stop, so nothing to confirm — but the board's save is debounced (350 ms, pushed
    // back by every keystroke), and this was the only path that did not flush it: closing the window
    // after typing into a note threw away everything since the last pause, and note, text, checklist
    // and kanban content lives nowhere but the board file. The page saves, then quits.
    ctx.emit('app:saveAndQuit')
    clearTimeout(quitWatchdog)
    quitWatchdog = setTimeout(() => {
      logError('quit', new Error('the window did not answer the save-and-quit request; closing it anyway'))
      quitConfirmed = true
      win?.close()
    }, QUIT_ACK_MS)
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/**
 * Stop everything that outlives a window unless told to. Headless runs and goal checks are not
 * consoles, so dispose() never sees them: a planner run or an `npm test` goal check outlived the app,
 * spending tokens with its output going nowhere. Both quit paths run it (app:quit destroys the last
 * window, so window-all-closed follows), and the second gets the first's promise instead of a rerun.
 */
let stopping: Promise<void> | undefined
const shutdown = () =>
  (stopping ??= (async () => {
    cli.killRuns()
    goal.killGoalChecks()
    stopFleetTicks()
    await ptys.dispose()
  })())

function registerCore() {
  ipcMain.handle('pty:spawn', (_e, req) => ptys.spawn(req))
  ipcMain.on('app:background', (_e, color: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return
    win?.setBackgroundColor(color)
    if (process.platform === 'win32') {
      const t = THEMES.find((x) => x.tokens.bg.toLowerCase() === color.toLowerCase())
      if (t) win?.setTitleBarOverlay(overlayFor(t))
    }
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:paste', (_e, id: string, text: string, submit: boolean) => ptys.send(id, String(text), submit))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.handle('pty:pause', (_e, id: string) => ptys.pause(id))
  ipcMain.handle('pty:resume', (_e, id: string) => ptys.resume(id))
  ipcMain.handle('pty:buffer', (_e, id: string) => ptys.buffer(id))
  ipcMain.handle('pty:tail', (_e, id: string, chars?: number) => ptys.tail(id, chars))
  ipcMain.handle('pty:prompt', (_e, id: string) => ptys.screen(id)?.prompt ?? null)
  ipcMain.handle('pty:answer', async (_e, id: string, answer) => {
    const r = await ptys.answer(id, answer)
    if (r.ok) journal.answered('you, on the board', id, describeAnswer(answer))
    return r
  })
  // a team rule answering for you (teamRules.ts): only while the prompt asks for that very command
  ipcMain.handle('pty:answerByRule', async (_e, id: string, answer, command: string, who: string) => {
    if (typeof command !== 'string' || !command) return { ok: false, reason: 'changed' }
    const r = await ptys.answer(id, answer, command)
    if (r.ok) journal.append({ kind: 'prompt.answer', text: `Fleetboard allowed \`${command.split('\n')[0]}\` for ${String(who)}, by your rule for its team`, detail: { consoleId: id, by: 'rule', command } })
    return r
  })
  ipcMain.handle('pty:deliver', (_e, id: string, text: string) => ptys.deliver(id, String(text)))
  ipcMain.handle('pty:list', () => ptys.list())

  ipcMain.handle('app:quit', async () => {
    quitConfirmed = true
    await shutdown()
    // the board is already saved; don't let a slow child process keep the app alive
    win?.destroy()
    win = null
    setTimeout(() => app.exit(0), 300)
  })
  // "I got the save-and-quit request and I am working on it": stops the watchdog above from
  // closing the window while the save, or the dialog a failed save opens, is still going.
  ipcMain.on('app:quitAck', () => clearTimeout(quitWatchdog))
  // the renderer's own stray errors, into the same log as the main process's
  ipcMain.on('app:logError', (_e, message: string) => logError('renderer', String(message).slice(0, 4000)))

  // asked once by a page as it starts: was it reloaded after the window crashed?
  ipcMain.handle('app:crashRecovered', () => {
    const was = crashRecovered
    crashRecovered = false
    return was
  })
  // how long nobody has touched this computer: the Inbox's "while you were away" (renderer away.ts).
  // 0 where the platform can't tell (some Wayland compositors), which just means focus alone decides
  ipcMain.handle('app:idleSeconds', () => powerMonitor.getSystemIdleTime())
  ipcMain.handle('app:paths', () => ({ root: toRendererPath(dirs.root), home: toRendererPath(app.getPath('home')), assets: toRendererPath(dirs.assets) }))
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('webview:devtools', (_e, webContentsId: number) => {
    webContents.fromId(webContentsId)?.openDevTools({ mode: 'detach' })
  })

  // Render HTML to a real paginated PDF (document studio, markdown export).
  ipcMain.handle('pdf:fromHtml', async (_e, html: string, outPath: string) => {
    if (!allowed(outPath, 'pdf:fromHtml')) throw new Error(outsideMessage(outPath))
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    w.destroy()
    const fs = await import('node:fs')
    fs.writeFileSync(outPath, pdf)
    return outPath
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
  protocol.handle('fbfile', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname)
    // fbfile:///C:/dir/file → C:/dir/file
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    // the renderer builds these URLs out of board data, which agents write, and the scheme is
    // registered bypassCSP — so it is the same question as fs:read, and gets the same answer
    if (!allowed(p, 'fbfile')) return new Response('', { status: 403 })
    return net.fetch(pathToFileURL(p).toString())
  })
  // Microphone for push-to-talk; the camera and everything else stays denied. The *check* handler
  // matters as much as the request one: without it a check falls through to Electron's own answer,
  // which is to allow.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(appPermission(permission, mediaTypesOf(details))))
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => appPermission(permission, mediaTypesOf(details)))
  // Web tiles: Electron grants every permission unless told otherwise (see webPermission).
  const web = session.fromPartition(WEB_PARTITION)
  const told = new Set<string>()
  const refused = (permission: string) => {
    // one notice per permission: a page may ask on every frame, and the toasts would bury the board
    if (told.has(permission) || told.size > 50) return
    told.add(permission)
    ctx.emit('app:notice', `A web tile asked for ${permission.replace(/-/g, ' ')} and was refused. Fleetboard allows a page only the microphone and notifications, and only from your own machine.`)
  }
  web.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok = webPermission(permission, details.requestingUrl, mediaTypesOf(details))
    if (!ok) refused(permission)
    cb(ok)
  })
  web.setPermissionCheckHandler((_wc, permission, origin, details) => webPermission(permission, origin, mediaTypesOf(details)))
  // before any console starts: what a run that died left running would otherwise work on unseen
  const orphans = await endOrphans().catch(() => 0)
  if (orphans) logError('startup', new Error(`stopped ${orphans} console process${orphans === 1 ? '' : 'es'} the last run left running`))
  await startHookServer((id, event, payload) => ptys.hook(id, event, payload))
  registerCore()
  // every module that takes IPC, in one list, so this reads as the map it looks like. skills used to
  // be registered from inside profiles, which made its handlers appear to come from nowhere.
  for (const m of [store, fsops, cli, agents, git, usage, profiles, skills, goal, knowledge, ci, sweep, starter, journal]) m.register(ctx)
  // these two start servers, so they are awaited rather than listed
  await fleet.register(ctx)
  await remote.register(ctx)
  createWindow()
})

app.on('window-all-closed', async () => {
  await shutdown()
  app.quit()
})
