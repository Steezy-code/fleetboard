// Stands in for the `electron` module when main-process code is imported by unit tests.
// Every call is recorded in `calls`; nothing touches a real window or the desktop.

export const calls: { api: string; args: unknown[] }[] = []
const record =
  (api: string, ret: unknown = undefined) =>
  (...args: unknown[]) => {
    calls.push({ api, args })
    return ret
  }

export const shell = {
  openExternal: record('shell.openExternal', Promise.resolve()),
  openPath: record('shell.openPath', Promise.resolve('')),
  showItemInFolder: record('shell.showItemInFolder'),
  trashItem: record('shell.trashItem', Promise.resolve())
}

export const dialog = {
  showOpenDialog: record('dialog.showOpenDialog', Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: record('dialog.showSaveDialog', Promise.resolve({ canceled: true })),
  showMessageBox: record('dialog.showMessageBox', Promise.resolve({ response: 0 }))
}

/** An ipcMain whose handlers tests can call directly: `await ipcMain.invoke('channel', ...args)`. */
export const ipcMain = {
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  handle(channel: string, fn: (...args: any[]) => any) {
    this.handlers.set(channel, fn)
  },
  on(channel: string, fn: (...args: any[]) => any) {
    this.listeners.set(channel, fn)
  },
  removeHandler(channel: string) {
    this.handlers.delete(channel)
  },
  async invoke(channel: string, ...args: unknown[]) {
    const h = this.handlers.get(channel)
    if (!h) throw new Error(`no handler for ${channel}`)
    return h({ sender: null }, ...args)
  }
}

export const app = {
  getPath: (name: string) => `/tmp/fleetboard-test-${name}`,
  getName: () => 'Fleetboard',
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  on: record('app.on'),
  quit: record('app.quit')
}

export class BrowserWindow {
  static getAllWindows() {
    return []
  }
}

export const webContents = { fromId: () => null }
export const Menu = { setApplicationMenu: record('Menu.setApplicationMenu') }
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) }
export const protocol = { handle: record('protocol.handle'), registerSchemesAsPrivileged: record('protocol.registerSchemesAsPrivileged') }
export const session = { defaultSession: { setPermissionRequestHandler: record('session.setPermissionRequestHandler') } }

export default { shell, dialog, ipcMain, app, BrowserWindow, webContents, Menu, net, protocol, session }
