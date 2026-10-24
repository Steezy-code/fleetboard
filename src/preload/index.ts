import { INVOKE_CHANNELS, SEND_CHANNELS, EVENT_CHANNELS, validateIpc } from '../shared/ipc'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

// One generic bridge. Feature modules talk to the main process through named channels.
const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) throw new Error('Unknown invoke channel')
    validateIpc(channel, args)
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel: string, ...args: unknown[]) => {
    // only pathForFile below may say the user dropped a file: from here it would grant any path
    if (channel === 'fs:grantDropped') throw new Error('fs:grantDropped is sent by pathForFile only')
    if (!(SEND_CHANNELS as readonly string[]).includes(channel)) throw new Error('Unknown send channel')
    validateIpc(channel, args)
    ipcRenderer.send(channel, ...args)
  },
  on: (channel: string, cb: (...args: any[]) => void) => {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) throw new Error('Unknown event channel')
    const listener = (_e: unknown, ...args: any[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  /**
   * The real path of a file dropped on the board (or chosen in a file input), and a note to the main
   * process that the user chose it — otherwise the filesystem handlers would refuse everything
   * dragged in from outside the project. This is not something the renderer can forge: Electron
   * returns an empty string for a File built in JS rather than backed by a file on disk, so only a
   * genuine drop or pick produces a path here.
   */
  pathForFile: (file: File) => {
    const p = webUtils.getPathForFile(file)
    if (p) ipcRenderer.send('fs:grantDropped', p)
    return p
  },
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
