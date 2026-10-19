// Handles for automation and debugging from DevTools: window.__fleetboard.
import { useApp, activeWs, allConsoles } from './state/store'
import { spawnConsoles, sendToConsole, consoleTail, resolveTargets } from './engine/consoles'
import { synthesize, ttsReady, warmUpTts } from './voice/tts'
import { transcribe, warmUpStt, sttReady } from './voice/stt'
import { markdownToHtmlDocument } from './workbench/pdf'
import { figureItems, figureToExcalidraw, figureToPngBase64, figureToSvg } from './studios/diagrams/export'

;(window as any).__fleetboard = {
  useApp,
  activeWs,
  allConsoles,
  spawnConsoles,
  sendToConsole,
  consoleTail,
  resolveTargets,
  voice: { synthesize, ttsReady, warmUpTts, transcribe, warmUpStt, sttReady },
  exportHelpers: { markdownToHtmlDocument, figureItems, figureToSvg, figureToPngBase64, figureToExcalidraw }
}
