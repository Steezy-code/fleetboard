// End-to-end harness: launches the built app (out/) as a separate Fleetboard with its own state,
// home folder and PATH, where `claude` is the scripted fake (test/fake-agent/claude.mjs), and drives
// it over the Chrome DevTools Protocol. Run under a display (npm run test:e2e uses xvfb-run).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../..')
const ELECTRON: string = require('electron')
export const FAKE_CLAUDE = path.join(ROOT, 'test/fake-agent/claude.mjs')

export interface LaunchOptions {
  /** scenario for the fake claude (see test/fake-agent/claude.mjs) */
  scenario?: object
  /** reuse an existing sandbox (to test a restart) */
  sandbox?: Sandbox
  /**
   * Use the real `claude` (next to this node) with this config dir instead of the fake, keeping
   * this process's API environment. For manual stress runs (test/e2e/real), never in CI.
   */
  realClaudeConfig?: string
  /** extra Chromium/Electron switches */
  extraArgs?: string[]
  /** open the main process's inspector, for evalMain() */
  mainInspector?: boolean
}

export interface Sandbox {
  dir: string
  home: string
  fbHome: string
  bin: string
  log: string
  scenarioFile: string
}

export function makeSandbox(opts: { fake?: boolean } = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-'))
  const sb: Sandbox = {
    dir,
    home: path.join(dir, 'home'),
    fbHome: path.join(dir, 'fleetboard'),
    bin: path.join(dir, 'bin'),
    log: path.join(dir, 'fake-claude.log'),
    scenarioFile: path.join(dir, 'scenario.json')
  }
  for (const d of [sb.home, sb.fbHome, sb.bin]) fs.mkdirSync(d, { recursive: true })
  // `claude` on PATH is the fake, started with this same node
  if (opts.fake !== false) fs.writeFileSync(path.join(sb.bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 })
  // the app reads PATH from a login shell, and /etc/profile may reset it: set it where a user would
  fs.writeFileSync(path.join(sb.home, '.bash_profile'), `export PATH="${sb.bin}:${path.dirname(process.execPath)}:$PATH"\n`)
  fs.writeFileSync(path.join(sb.home, '.gitconfig'), '[user]\n\tname = Fleetboard Test\n\temail = test@fleetboard.invalid\n[init]\n\tdefaultBranch = main\n')
  fs.writeFileSync(sb.scenarioFile, '{}')
  return sb
}

/** A git repo with one commit, inside the sandbox. */
export function makeRepo(sb: Sandbox, name = 'repo', files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = path.join(sb.dir, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), c)
  }
  const env = { ...process.env, HOME: sb.home }
  execFileSync('git', ['init', '-q'], { cwd: dir, env })
  execFileSync('git', ['add', '-A'], { cwd: dir, env })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env })
  return dir
}

export const git = (sb: Sandbox, cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, HOME: sb.home }, encoding: 'utf8' }).trim()

// ------------------------------------------------------------------ CDP

class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  /** protocol events (no id): method and params */
  readonly events: ((method: string, params: any) => void)[] = []
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (!msg.id && msg.method) for (const l of this.events) l(msg.method, msg.params)
      const p = msg.id && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }
  static async connect(url: string) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }
  /** A call that gets no answer (a crashed page never answers) fails after `timeout` instead of hanging the test. */
  send(method: string, params: object = {}, timeout = 30_000): Promise<any> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no answer to ${method} in ${timeout} ms`))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
    })
  }
  close() {
    this.ws.close()
  }
}

// ------------------------------------------------------------------ app

export class App {
  /** uncaught exceptions and console.error calls in the app window, in order */
  readonly rendererErrors: string[] = []

  private constructor(
    readonly sb: Sandbox,
    private proc: ChildProcess,
    private cdp: Cdp,
    private output: () => string,
    private port: string
  ) {}

  /**
   * Another page of the app, such as the content of a web tile (a <webview> target), by URL. Returns an
   * evaluator like eval().
   */
  async target(match: (url: string) => boolean, timeout = 20_000) {
    let ws = ''
    await this.waitFor(
      async () => {
        const list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as { url: string; webSocketDebuggerUrl: string }[]
        ws = list.find((t) => match(t.url))?.webSocketDebuggerUrl ?? ''
        return ws
      },
      { timeout, label: 'target' }
    )
    const cdp = await Cdp.connect(ws)
    await cdp.send('Runtime.enable')
    return {
      eval: async <T>(expression: string): Promise<T> => {
        const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value as T
      },
      close: () => cdp.close()
    }
  }

  static async launch(opts: LaunchOptions = {}): Promise<App> {
    if (!fs.existsSync(path.join(ROOT, 'out/main/index.js'))) throw new Error('build the app first: npx electron-vite build')
    const sb = opts.sandbox ?? makeSandbox()
    if (opts.scenario) fs.writeFileSync(sb.scenarioFile, JSON.stringify(opts.scenario))
    const env: Record<string, string> = {}
    // the test runner's own variables must not reach the app's consoles (node --test inside them breaks)
    const keep = opts.realClaudeConfig ? /^(ELECTRON_RUN_AS_NODE|CLAUDECODE|NODE_TEST_CONTEXT|NODE_OPTIONS)$/ : /^(CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE|NODE_TEST_CONTEXT|NODE_OPTIONS)/
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !keep.test(k)) env[k] = v
    if (opts.realClaudeConfig) env.CLAUDE_CONFIG_DIR = opts.realClaudeConfig
    Object.assign(env, {
      HOME: sb.home,
      FLEETBOARD_HOME: sb.fbHome,
      SHELL: '/bin/bash',
      PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      FAKE_CLAUDE_LOG: sb.log,
      FAKE_CLAUDE_SCENARIO: sb.scenarioFile,
      XDG_CONFIG_HOME: path.join(sb.home, '.config')
    })
    const inspect = opts.mainInspector ? ['--inspect=0'] : []
    const proc = spawn(ELECTRON, ['--no-sandbox', '--remote-debugging-port=0', ...inspect, ...(opts.extraArgs ?? []), path.join(ROOT, 'out/main/index.js')], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`app did not start:\n${output.slice(-3000)}`)), 30_000)
      const onData = (d: Buffer) => {
        output += d.toString()
        if (output.length > 200_000) output = output.slice(-100_000)
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(output)
        if (m) {
          clearTimeout(timer)
          resolve(m[1])
        }
      }
      proc.stdout!.on('data', onData)
      proc.stderr!.on('data', onData)
      proc.on('exit', (code) => reject(new Error(`app exited (${code}) before starting:\n${output.slice(-3000)}`)))
    })
    const port = new URL(wsUrl).port
    // the window's page target appears shortly after the browser endpoint
    let pageWs = ''
    for (let i = 0; i < 100 && !pageWs; i++) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      pageWs = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))?.webSocketDebuggerUrl ?? ''
      if (!pageWs) await new Promise((r) => setTimeout(r, 100))
    }
    if (!pageWs) throw new Error('no app window')
    const cdp = await Cdp.connect(pageWs)
    const app = new App(sb, proc, cdp, () => output, port)
    cdp.events.push((method, params) => {
      if (method === 'Runtime.exceptionThrown') app.rendererErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception')
      if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert'))
        app.rendererErrors.push((params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '))
    })
    await cdp.send('Runtime.enable')
    await app.waitFor(() => app.eval(() => !!(window as any).__fleetboard), { label: 'app ready' })
    return app
  }

  private main?: Cdp

  /** Evaluate an expression in the main process (launch with mainInspector). */
  async evalMain<T = unknown>(expression: string): Promise<T> {
    if (!this.main) {
      const url = /Debugger listening on (ws:\/\/\S+)/.exec(this.output())?.[1]
      if (!url) throw new Error('no main-process inspector: launch with mainInspector')
      this.main = await Cdp.connect(url)
      await this.main.send('Runtime.enable')
    }
    const r = await this.main.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`in main: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value as T
  }

  /** Whether the app's process ends within `ms`. */
  waitExit(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve(true)
      const t = setTimeout(() => resolve(false), ms)
      this.proc.once('exit', () => (clearTimeout(t), resolve(true)))
    })
  }

  /** Crash the window's page, as running out of memory would (the protocol never answers this). */
  async crashWindow() {
    void this.cdp.send('Page.crash', {}, 1000).catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
  }

  /** Run a function in the renderer. It must be self-contained; pass data through `arg`. */
  async eval<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(`in renderer: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value as T
  }

  /** IPC from the renderer, like the app does it. */
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    return this.eval(({ channel, args }) => (window as any).fb.invoke(channel, ...args), { channel, args })
  }

  async waitFor<T>(fn: () => Promise<T> | T, opts: { timeout?: number; label?: string; every?: number } = {}): Promise<NonNullable<T>> {
    const until = Date.now() + (opts.timeout ?? 20_000)
    let last: unknown
    for (;;) {
      try {
        last = await fn()
        if (last) return last as NonNullable<T>
      } catch (e) {
        last = e
      }
      if (Date.now() > until) throw new Error(`timed out waiting for ${opts.label ?? fn.toString().slice(0, 120)} (last: ${String(last).slice(0, 300)})`)
      await new Promise((r) => setTimeout(r, opts.every ?? 150))
    }
  }

  async openProject(dir: string) {
    await this.eval((dir) => (window as any).__fleetboard.useApp.getState().openProject(dir), dir)
    await this.waitFor(() => this.eval((dir) => (window as any).__fleetboard.useApp.getState().project?.path === dir, dir), { label: 'project open' })
    return this.eval(() => (window as any).__fleetboard.useApp.getState().project.id as string)
  }

  status(id: string) {
    return this.eval((id) => (window as any).__fleetboard.useApp.getState().statuses[id] as string | undefined, id)
  }

  waitStatus(id: string, status: string, timeout = 20_000) {
    return this.waitFor(async () => (await this.status(id)) === status, { timeout, label: `console ${id} ${status} (is ${'' + ''})` }).catch(async (e) => {
      throw new Error(`${e.message}; status is ${await this.status(id)}; screen:\n${await this.invoke('pty:tail', id, 1500)}`)
    })
  }

  /** Click the first element matching `selector` whose text contains `text`. */
  async click(selector: string, text?: string) {
    const ok = await this.eval(
      ({ selector, text }) => {
        const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => !text || e.textContent?.includes(text))
        el?.click()
        return !!el
      },
      { selector, text }
    )
    if (!ok) throw new Error(`nothing to click: ${selector}${text ? ` "${text}"` : ''}`)
  }

  texts(selector: string) {
    return this.eval((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((e) => e.innerText), selector)
  }

  async screenshot(file: string) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  }

  /** Events the fake claude logged, oldest first. */
  fakeLog(filter?: (e: any) => boolean): any[] {
    if (!fs.existsSync(this.sb.log)) return []
    const all = fs
      .readFileSync(this.sb.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    return filter ? all.filter(filter) : all
  }

  get appOutput() {
    return this.output()
  }

  /**
   * Quit the way a user does: close the window, confirm "Quit with N consoles running?" (the board is
   * saved then), and wait for the app to exit.
   */
  async quitLikeUser() {
    await this.invoke('win:close').catch(() => {})
    try {
      await this.waitFor(() => this.eval(() => !![...document.querySelectorAll('button')].find((b) => b.textContent === 'Quit')), { timeout: 5000, label: 'quit confirmation' })
      await this.click('button', 'Quit')
    } catch {
      /* nothing running: the window closed without asking */
    }
    const exited = await this.waitExit(10_000)
    this.cdp.close()
    this.main?.close()
    return exited
  }

  /** Quit like the user does (consoles are stopped), then make sure nothing is left running. */
  async close() {
    // the window is destroyed while answering: the reply may never come
    await Promise.race([this.invoke('app:quit').catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    this.cdp.close()
    this.main?.close()
    const exited = await new Promise<boolean>((resolve) => {
      if (this.proc.exitCode !== null) return resolve(true)
      const t = setTimeout(() => resolve(false), 8000)
      this.proc.once('exit', () => (clearTimeout(t), resolve(true)))
    })
    try {
      process.kill(-this.proc.pid!, 'SIGKILL')
    } catch {
      /* already gone */
    }
    return exited
  }
}
