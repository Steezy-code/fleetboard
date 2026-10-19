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
  platform: process.platform
}

contextBridge.exposeInMainWorld('fb', api)
export type FbApi = typeof api
