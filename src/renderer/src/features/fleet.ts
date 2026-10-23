// Lead/worker teams: styles for the Inbox tray on the command bar (fleet/InboxTray.tsx) and team UI,
// and the read of each board's repo that its charters cite (fleet/knowledge.ts).
import '../styles/fleet.css'
import { registerEngine } from '../engine/engines'
import { watchKnowledge } from '../fleet/knowledge'

// each board's repo is read as it opens, so the first goal typed into it already has its checks known
registerEngine(watchKnowledge)
