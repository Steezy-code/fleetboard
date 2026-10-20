import { contextBridge, ipcRenderer, webUtils } from 'electron'

// One generic bridge. Feature modules talk to the main process through named channels.
const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, cb: (...args: any[]) => void) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
  /**
   * Whether this run may expose window.__fleetboard (see renderer/src/debug.ts).
   *
   * ELECTRON_RENDERER_URL is set only by `electron-vite dev`, and is what index.ts already uses to
   * tell dev from packaged. The end-to-end tests drive the *built* app through those handles, so
   * they set FLEETBOARD_DEVTOOLS; a packaged app has neither.
   */
  devtools: !!process.env.ELECTRON_RENDERER_URL || process.env.FLEETBOARD_DEVTOOLS === '1'
}

contextBridge.exposeInMainWorld('fb', api)
export type FbApi = typeof api
