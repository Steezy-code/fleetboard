import * as recovery from './recovery'
import { guardedIpc } from './ipc'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, session, shell, webContents } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
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
import * as update from './update'
import * as fleet from './fleet'
import { stopFleetTicks } from './fleet'
import * as remote from './remote'
import { dirs } from './paths'
import { THEMES, themeById, type Theme } from '@shared/themes'
import { toRendererPath } from './platform'
import { catchStrayErrors, logError, logRepeated } from './errors'
import { appPermission, mediaTypesOf, webPermission } from './permissions'
import * as journal from './journal'
import { allowed, allowedPath, outsideMessage } from './roots'
import { endOrphans } from './orphans'
import { definitionFingerprint } from './teamrules'
import { teamRuleAllowed } from '@shared/approvals'

let win: BrowserWindow | null = null

/** The session web tiles browse in (WebNode's <webview partition>). */
const WEB_PARTITION = 'persist:fleetboard-web'
// Whatever the renderer asks for, a web tile never gets Node, a preload or an unsandboxed process —
// and it browses in the web tiles' own session. In any other (the app's default one, which may use the
// microphone and read the clipboard) a page would be granted what appPermission allows the app itself.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    if (params.partition !== WEB_PARTITION) {
      ev.preventDefault()
      logError('webview', `a web tile asked for session "${params.partition}" and was not attached`)
    }
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
/** the page crashed too often to be reloaded: nothing in the window can answer any more */
let pageDead = false
let askingNatively = false

/**
 * Quit with consoles running, asked by the main process itself: for when the page cannot ask. The
 * board was last saved by the page while it lived; what it had not saved yet cannot be reached now.
 */
async function askToQuitNatively() {
  if (askingNatively || !win || win.isDestroyed()) return
  askingNatively = true
  try {
    const n = ptys.size
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Fleetboard?',
      message: `Quit with ${n} console${n === 1 ? '' : 's'} running?`,
      detail: 'Their processes stop. The window is not responding, so changes it had not saved yet may be lost.'
    })
    if (response !== 0) return
    quitConfirmed = true
    await shutdown()
    win?.destroy()
    win = null
    setTimeout(() => app.exit(0), 300)
  } finally {
    askingNatively = false
  }
}

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
  ipc: guardedIpc(ipcMain, () => win),
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
    // FB_E2E_HEADLESS on Windows: --ozone-platform=headless is Chromium's Linux switch and does
    // nothing here, so the window goes off the screen instead of onto it. The self-hosted runner
    // shares a logon session with whoever is using the machine, and a suite that flashes windows over
    // their work is a suite they turn off.
    //
    // ponytail: far-offscreen coordinates rather than `show: false`, which stops the compositor and
    // with it the screenshots a failing test is meant to leave behind.
    ...(process.platform === 'win32' && process.env.FB_E2E_HEADLESS ? { x: -32000, y: -32000, skipTaskbar: true } : {}),
    title: 'Fleetboard',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
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
      pageDead = true
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
    pageDead = false
    win.webContents.reload()
  })
  win.on('closed', () => {
    win = null
  })
  win.on('close', (e) => {
    if (quitConfirmed) return
    e.preventDefault()
    if (ptys.size) {
      // The page asks the user (it knows about unsaved editors too). A page that is gone — crashed
      // past the retries, or hung — cannot, and the window used to be unclosable then: the "keeps
      // crashing" dialog said to restart, and nothing could. So it is asked here instead.
      if (pageDead || win?.webContents.isCrashed()) return void askToQuitNatively()
      ctx.emit('app:confirmQuit', ptys.size)
      clearTimeout(quitWatchdog)
      quitWatchdog = setTimeout(() => void askToQuitNatively(), QUIT_ACK_MS)
      return
    }
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

/** The session PDFs are printed in. */
const PRINT_PARTITION = 'pdf-print'
/** pages being printed right now: the only file: URLs that session may load */
const printing = new Set<string>()
let printGuarded = false
/**
 * A page printed from a file may load the file itself and what a data: page could (images over the
 * network, inline data) — never another local file, which an <iframe src="file:///…"> would otherwise
 * print into the PDF.
 */
function printOnly(page: string) {
  printing.add(page)
  setTimeout(() => printing.delete(page), 120_000).unref?.()
  if (printGuarded) return
  printGuarded = true
  session.fromPartition(PRINT_PARTITION).webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    cb({ cancel: !(printing.has(url) || /^(data|https?):/i.test(url)) })
  })
}

function registerCore() {
  ctx.ipc.handle('pty:spawn', (_e, req) => ptys.spawn(req))
  ctx.ipc.on('app:background', (_e, color: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return
    win?.setBackgroundColor(color)
    if (process.platform === 'win32') {
      const t = THEMES.find((x) => x.tokens.bg.toLowerCase() === color.toLowerCase())
      if (t) win?.setTitleBarOverlay(overlayFor(t))
    }
  })
  ctx.ipc.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ctx.ipc.on('pty:paste', (_e, id: string, text: string, submit: boolean) => ptys.send(id, String(text), submit))
  ctx.ipc.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ctx.ipc.handle('pty:kill', (_e, id: string) => ptys.kill(id))
  ctx.ipc.handle('pty:pause', (_e, id: string) => ptys.pause(id))
  ctx.ipc.handle('pty:resume', (_e, id: string) => ptys.resume(id))
  ctx.ipc.handle('pty:buffer', (_e, id: string) => ptys.buffer(id))
  ctx.ipc.handle('pty:tail', (_e, id: string, chars?: number) => ptys.tail(id, chars))
  ctx.ipc.handle('pty:prompt', (_e, id: string) => ptys.screen(id)?.prompt ?? null)
  ctx.ipc.handle('pty:answer', async (_e, id: string, answer) => {
    const r = await ptys.answer(id, answer)
    if (r.ok) journal.answered('you, on the board', id, describeAnswer(answer))
    return r
  })
  // A team rule answering for you (renderer fleet/teamRules.ts), decided here rather than trusted from
  // the renderer: only a command of a kind a rule may cover (teamRuleAllowed), only while the files
  // that define it are as they were when the user said yes (teamrules.ts), and only while the prompt
  // still asks for that very command (ptys.answer).
  ctx.ipc.handle('pty:ruleFingerprint', (_e, id: string) => {
    const cwd = ptys.cwdOf(String(id))
    return cwd ? definitionFingerprint(cwd) : null
  })
  ctx.ipc.handle('pty:answerByRule', async (_e, id: string, answer, command: string, who: string, fingerprint: string) => {
    if (typeof command !== 'string' || !command) return { ok: false, reason: 'changed' }
    if (!teamRuleAllowed(command)) return { ok: false, reason: 'changed' }
    const cwd = ptys.cwdOf(id)
    if (!cwd) return { ok: false, reason: 'not-live' }
    const now = definitionFingerprint(cwd)
    if (!now || now !== fingerprint) return { ok: false, reason: 'redefined' }
    const r = await ptys.answer(id, answer, command)
    if (r.ok) journal.append({ kind: 'prompt.answer', text: `Fleetboard allowed \`${command.split('\n')[0]}\` for ${String(who)}, by your rule for its team`, detail: { consoleId: id, by: 'rule', command } })
    return r
  })
  ctx.ipc.handle('pty:deliver', (_e, id: string, text: string) => ptys.deliver(id, String(text)))
  ctx.ipc.handle('pty:list', () => ptys.list())
  ctx.ipc.handle('pty:info', (_e, id: string) => ptys.infoOf(String(id)))

  ctx.ipc.handle('app:quit', async () => {
    quitConfirmed = true
    await shutdown()
    // the board is already saved; don't let a slow child process keep the app alive
    win?.destroy()
    win = null
    setTimeout(() => app.exit(0), 300)
  })
  // "I got the save-and-quit request and I am working on it": stops the watchdog above from
  // closing the window while the save, or the dialog a failed save opens, is still going.
  ctx.ipc.on('app:quitAck', () => clearTimeout(quitWatchdog))
  // the renderer's own stray errors, into the same log as the main process's
  ctx.ipc.on('app:logError', (_e, message: string) => void logRepeated('renderer', String(message).slice(0, 4000)))

  // asked once by a page as it starts: was it reloaded after the window crashed?
  ctx.ipc.handle('app:crashRecovered', () => {
    const was = crashRecovered
    crashRecovered = false
    return was
  })
  // how long nobody has touched this computer: the Inbox's "while you were away" (renderer away.ts).
  // 0 where the platform can't tell (some Wayland compositors), which just means focus alone decides
  ctx.ipc.handle('app:idleSeconds', () => powerMonitor.getSystemIdleTime())
  ctx.ipc.handle('app:paths', () => ({ root: toRendererPath(dirs.root), home: toRendererPath(app.getPath('home')), assets: toRendererPath(dirs.assets) }))
  ctx.ipc.handle('win:minimize', () => win?.minimize())
  ctx.ipc.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ctx.ipc.handle('win:close', () => win?.close())
  ctx.ipc.handle('webview:devtools', (_e, webContentsId: number) => {
    webContents.fromId(webContentsId)?.openDevTools({ mode: 'detach' })
  })

  // Render HTML to a real paginated PDF (document studio, markdown export).
  ctx.ipc.handle('pdf:fromHtml', async (_e, html: string, outPath: string) => {
    const target = allowedPath(outPath, 'pdf:fromHtml')
    if (!target) throw new Error(outsideMessage(outPath))
    // The HTML is the renderer's, rendered markdown today: printed as a page, never run as one. No
    // scripts, a session of its own that keeps nothing, and nowhere to navigate or open a window to.
    //
    // Loaded from a file rather than a data: URL. Chromium refuses a URL past 2 MiB, and percent-
    // encoding triples anything that is not ASCII, so a long document failed to export — and the
    // hidden window, never destroyed on that path, stayed behind for the rest of the session.
    const page = path.join(dirs.exports, `print-${process.pid}-${Date.now()}.html`)
    printOnly(pathToFileURL(page).href)
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, partition: PRINT_PARTITION } })
    try {
      w.webContents.on('will-navigate', (e) => e.preventDefault())
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await fs.promises.writeFile(page, html, 'utf8')
      await w.loadFile(page)
      const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
      await fs.promises.writeFile(target, pdf)
      return target
    } finally {
      if (!w.isDestroyed()) w.destroy()
      printing.delete(pathToFileURL(page).href)
      void fs.promises.rm(page, { force: true }).catch(() => {})
    }
  })
}

// The dev server's address and the test hooks are for `electron-vite dev` and the end-to-end tests: a
// packaged app honouring them would load its window from wherever the environment pointed.
if (app.isPackaged) {
  delete process.env.ELECTRON_RENDERER_URL
  delete process.env.FLEETBOARD_DEVTOOLS
  delete process.env.FB_E2E_HEADLESS
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
  // Every step on the way to the window is guarded on its own. One that threw used to end this
  // promise before createWindow: the app then ran on with no window, holding the single-instance
  // lock, so every later launch only "focused" a window that did not exist — and one malformed state
  // file was enough to do it. Now the window always opens, and says what did not start.
  const failed: string[] = []
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn()
    } catch (e) {
      failed.push(name)
      logError('startup', e)
    }
  }
  // before any console starts: what a run that died left running would otherwise work on unseen
  await step('orphans', async () => {
    const orphans = await endOrphans().catch(() => 0)
    if (orphans) logError('startup', new Error(`stopped ${orphans} console process${orphans === 1 ? '' : 'es'} the last run left running`))
  })
  await step('hooks', () => startHookServer((id, event, payload) => ptys.hook(id, event, payload)))
  await step('core', registerCore)
  // every module that takes IPC, in one list, so this reads as the map it looks like. skills used to
  // be registered from inside profiles, which made its handlers appear to come from nowhere.
  const modules = { store, recovery, fsops, cli, agents, git, usage, profiles, skills, goal, knowledge, ci, sweep, starter, journal, update }
  for (const [name, m] of Object.entries(modules)) await step(name, () => m.register(ctx))
  // these two start servers, so they are awaited rather than listed
  await step('teams', () => fleet.register(ctx))
  await step('phone inbox', () => remote.register(ctx))
  createWindow()
  if (failed.length) {
    // not showErrorBox: it would hold up this process, and with it every console's output
    void dialog.showMessageBox({
      type: 'warning',
      title: 'Part of Fleetboard did not start',
      message: `Some parts failed to start: ${failed.join(', ')}.`,
      detail: `The rest works. What went wrong is in ${path.join(dirs.root, 'logs', 'main.log')}.`
    })
  }
})

app.on('window-all-closed', async () => {
  await shutdown()
  app.quit()
})
