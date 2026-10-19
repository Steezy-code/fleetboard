// Handles for automation and debugging from DevTools: window.__fleetboard.
import { useApp, activeWs, allConsoles } from './state/store'
import { spawnConsoles, sendToConsole, consoleTail, resolveTargets } from './engine/consoles'

;(window as any).__fleetboard = { useApp, activeWs, allConsoles, spawnConsoles, sendToConsole, consoleTail, resolveTargets }
