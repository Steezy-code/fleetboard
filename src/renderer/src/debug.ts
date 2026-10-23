// Handles for automation and debugging from DevTools: window.__fleetboard.
//
// Not exposed in a packaged app. They are a ready-made toolkit — spawnConsoles, killConsoles,
// sendToConsole, handoff, sendGoal, fixCi — and script that gets into the window should have to
// build its own rather than find them waiting. The end-to-end tests drive the built app through
// them, so the gate is dev mode or the flag the test harness sets, not dev mode alone.
import { useApp, activeWs, allConsoles } from './state/store'
import { spawnConsoles, sendToConsole, consoleTail, resolveTargets, killConsoles } from './engine/consoles'
import { synthesize, ttsReady, warmUpTts } from './voice/tts'
import { transcribe, warmUpStt, sttReady } from './voice/stt'
import { markdownToHtmlDocument } from './workbench/pdf'
import { renderMarkdown, sanitizeHtml } from './workbench/markdown'
import { renderMarkdown as renderDocMarkdown } from './studios/docs/render'
import { handoff } from './engine/handoff'
import { sendGoal, useFleet } from './engine/fleet'
import { useCharter } from './fleet/charter'
import { useAway } from './fleet/away'
import { currentKnowledge, refreshKnowledge } from './fleet/knowledge'
import { useCi, applyCiStatus, ciItems, fixCi } from './workbench/ciStore'
import { useFeedback, applyFeedback, routeFeedback } from './workbench/prFeedback'
import { boardContext } from './voice/helm/context'
import { askHelm, coerceResult } from './voice/helm/helm'
import { figureItems, figureToExcalidraw, figureToPngBase64, figureToSvg } from './studios/diagrams/export'
import { NODE_DEFS } from './nodes/registry'
import { PANELS, DRAWERS } from './panels/registry'

if ((window as any).fb?.devtools === true) {
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
    sendGoal,
    // the charter waiting at the gate: nothing starts until it is confirmed, so a test that sends a goal confirms it here
    useCharter,
    // the repo knowledge charters cite: read again on demand, rather than waiting out its few minutes
    knowledge: { currentKnowledge, refreshKnowledge },
    // the board's mirror of the team. Writable, so a Ready card can be put up without running a
    // team: useFleet.setState({ state }) and the Inbox rebuilds from it.
    useFleet,
    // "while you were away": since (when you left) and summary (the card); writable, like useFleet
    useAway,
    NODE_DEFS,
    PANELS,
    DRAWERS,
    ci: { useCi, applyCiStatus, ciItems, fixCi, useFeedback, applyFeedback, routeFeedback },
    helm: { boardContext, askHelm, coerceResult },
    exportHelpers: { markdownToHtmlDocument, figureItems, figureToSvg, figureToPngBase64, figureToExcalidraw }
  }
}
