import type { BrowserWindow, IpcMain } from 'electron'
import type { Settings } from '@shared/types'
import type { PtyManager } from './pty'

/** Passed to every feature module's register(). */
export interface MainContext {
  ipc: IpcMain
  win: () => BrowserWindow | null
  ptys: PtyManager
  settings: () => Settings
  /** send an event to the renderer */
  emit: (channel: string, ...args: unknown[]) => void
}
