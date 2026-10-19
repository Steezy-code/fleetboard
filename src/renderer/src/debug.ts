// Handles for automation and debugging from DevTools: window.__fleetboard.
import { useApp, activeWs, allConsoles } from './state/store'
import { spawnConsoles, sendToConsole, consoleTail, resolveTargets, killConsoles } from './engine/consoles'
import { synthesize, ttsReady, warmUpTts } from './voice/tts'
import { transcribe, warmUpStt, sttReady } from './voice/stt'
import { markdownToHtmlDocument } from './workbench/pdf'
import { renderMarkdown, sanitizeHtml } from './workbench/markdown'
import { renderMarkdown as renderDocMarkdown } from './studios/docs/render'
import { handoff } from './engine/handoff'
import { figureItems, figureToExcalidraw, figureToPngBase64, figureToSvg } from './studios/diagrams/export'
import { NODE_DEFS } from './nodes/registry'
import { PANELS, DRAWERS } from './panels/registry'

;(window as any).__fleetboard = {
  useApp,
  activeWs,
  allConsoles,
  spawnConsoles,
  killConsoles,
  sendToConsole,
  consoleTail,
  resolveTargets,
  voice: { synthesize, ttsReady, warmUpTts, transcribe, warmUpStt, sttReady },
  markdown: { renderMarkdown, sanitizeHtml, renderDocMarkdown },
  handoff,
  NODE_DEFS,
  PANELS,
  DRAWERS,
  exportHelpers: { markdownToHtmlDocument, figureItems, figureToSvg, figureToPngBase64, figureToExcalidraw }
}
