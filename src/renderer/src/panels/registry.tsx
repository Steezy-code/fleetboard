import type { ComponentType } from 'react'
import SpawnPanel from './SpawnPanel'
import PresetsPanel from './PresetsPanel'
import ComposerPanel from './ComposerPanel'
import MissionMapPanel from './MissionMapPanel'
import OrchestratorPanel from './OrchestratorPanel'
import LoopsPanel from './LoopsPanel'
import HandoffPanel from './HandoffPanel'
import MemoryPanel from './MemoryPanel'
import KnowledgePanel from './KnowledgePanel'
import UsagePanel from './UsagePanel'
import AccountsPanel from './AccountsPanel'
import SkillsPanel from './SkillsPanel'
import SettingsPanel from './SettingsPanel'
import GitPanel from './GitPanel'
import ChatPanel from './ChatPanel'
import SweepPanel from './SweepPanel'
import CiPanel from './CiPanel'
import JournalPanel from './JournalPanel'
import CodeStudio from '../studios/CodeStudio'
import MarkdownStudio from '../studios/MarkdownStudio'
import DocumentsStudio from '../studios/DocumentsStudio'
import DiagramsStudio from '../studios/DiagramsStudio'
import { FleetDiffPanel } from '../fleet/Inbox'
import type { DrawerName, ModalName } from './names'

/**
 * Modals open with useApp.openPanel(name, props); drawers (floating right-side cards) with
 * useApp.openDrawer(name, props). Each component receives the props it was opened with. The names
 * are listed in names.ts, and `satisfies` keeps the two in step: a panel missing from either side,
 * or one only on one side, does not compile.
 */
export const PANELS: Record<string, ComponentType<any>> = {
  spawn: SpawnPanel,
  presets: PresetsPanel,
  composer: ComposerPanel,
  missionMap: MissionMapPanel,
  loops: LoopsPanel,
  handoff: HandoffPanel,
  memory: MemoryPanel,
  knowledge: KnowledgePanel,
  skills: SkillsPanel,
  settings: SettingsPanel,
  code: CodeStudio,
  markdown: MarkdownStudio,
  documents: DocumentsStudio,
  diagrams: DiagramsStudio,
  fleetDiff: FleetDiffPanel,
  sweep: SweepPanel
} satisfies Record<ModalName, ComponentType<any>>

export const DRAWERS: Record<string, ComponentType<any>> = {
  orchestrator: OrchestratorPanel,
  usage: UsagePanel,
  accounts: AccountsPanel,
  git: GitPanel,
  ci: CiPanel,
  chat: ChatPanel,
  journal: JournalPanel
} satisfies Record<DrawerName, ComponentType<any>>
