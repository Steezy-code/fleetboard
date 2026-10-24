import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { validateIpc } from '@shared/ipc'

/** Only the top frame of our own window may call privileged handlers, never a web tile. */
export function trustedSender(e: Pick<IpcMainEvent, 'sender' | 'senderFrame'> | Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, win: BrowserWindow | null): boolean {
  return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
}

export function guardedIpc(ipc: IpcMain, win: () => BrowserWindow | null): IpcMain {
  return new Proxy(ipc, {
    get(target, key) {
      if (key === 'handle') return (channel: string, fn: (...args: any[]) => unknown) => target.handle(channel, (e, ...args) => {
        if (!trustedSender(e, win())) throw new Error('Untrusted IPC sender')
        validateIpc(channel, args)
        return fn(e, ...args)
      })
      if (key === 'on') return (channel: string, fn: (...args: any[]) => unknown) => target.on(channel, (e, ...args) => {
        // Event senders have no promise to reject; invalid events must not throw in the main loop.
        if (!trustedSender(e, win())) return
        try { validateIpc(channel, args) } catch { return }
        fn(e, ...args)
      })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
