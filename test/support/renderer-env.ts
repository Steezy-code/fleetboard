// A minimal stand-in for the Electron renderer, so renderer logic (store, planner, loops, helm…) can be
// unit tested in Node. `window.fb` is a fake preload bridge: tests decide what each IPC channel answers
// and can see every call that was made.

type Handler = (...args: any[]) => any

const g = globalThis as any

export const ipc = {
  handlers: new Map<string, Handler>(),
  calls: [] as { channel: string; args: unknown[] }[],
  sent: [] as { channel: string; args: unknown[] }[],
  listeners: new Map<string, Set<Handler>>(),
  /** answer `invoke(channel, ...)` with fn's return value */
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn)
  },
  /** deliver a main → renderer event */
  emit(channel: string, ...args: unknown[]) {
    for (const cb of this.listeners.get(channel) ?? []) cb(...args)
  },
  callsTo(channel: string) {
    return this.calls.filter((c) => c.channel === channel).map((c) => c.args)
  },
  reset() {
    this.handlers.clear()
    this.calls.length = 0
    this.sent.length = 0
    this.listeners.clear()
  }
}

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
}

if (!g.window) {
  g.window = g
  g.localStorage = memoryStorage()
  g.sessionStorage = memoryStorage()
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)
  g.cancelAnimationFrame = (id: any) => clearTimeout(id)
  g.addEventListener = () => {}
  g.removeEventListener = () => {}
  g.dispatchEvent = () => true
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  g.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] }
  g.document = {
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    activeElement: null,
    // focused, so code that only notifies the OS when the window is in the background stays quiet
    hasFocus: () => true,
    fonts: { ready: Promise.resolve() }
  }
  g.fb = {
    invoke: async (channel: string, ...args: unknown[]) => {
      ipc.calls.push({ channel, args })
      const h = ipc.handlers.get(channel)
      return h ? h(...args) : undefined
    },
    send: (channel: string, ...args: unknown[]) => {
      ipc.sent.push({ channel, args })
    },
    on: (channel: string, cb: Handler) => {
      if (!ipc.listeners.has(channel)) ipc.listeners.set(channel, new Set())
      ipc.listeners.get(channel)!.add(cb)
      return () => ipc.listeners.get(channel)?.delete(cb)
    },
    pathForFile: () => ''
  }
}
