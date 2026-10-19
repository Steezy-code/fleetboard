import {
  Calendar,
  CheckSquare,
  FileCode2,
  FileText,
  GitBranch,
  Globe,
  Image,
  KanbanSquare,
  ListChecks,
  Network,
  StickyNote,
  SquareTerminal,
  Type
} from 'lucide-react'
import type { NodeType } from '@shared/types'
import type { NodeDef } from './types'
import ConsoleNode, { ConsoleActions, ConsoleHeader, beforeRemoveConsoles } from './ConsoleNode'
import WebNode from './WebNode'
import KanbanNode from './KanbanNode'
import CalendarNode from './CalendarNode'
import NoteNode from './NoteNode'
import TextNode from './TextNode'
import ChecklistNode from './ChecklistNode'
import ImageNode from './ImageNode'
import GitNode from './GitNode'
import FileNode from './FileNode'
import DocNode from './DocNode'
import OrchestratorNode from './OrchestratorNode'
import PlanNode from './PlanNode'

const defs: NodeDef[] = [
  {
    type: 'console', label: 'Console', icon: SquareTerminal, component: ConsoleNode, header: ConsoleHeader, actions: ConsoleActions,
    defaultSize: { w: 780, h: 440 }, minSize: { w: 360, h: 200 }, beforeRemove: beforeRemoveConsoles
  },
  { type: 'web', label: 'Web tile', icon: Globe, component: WebNode, defaultSize: { w: 720, h: 480 }, minSize: { w: 280, h: 200 }, create: () => ({ url: '' }) },
  { type: 'kanban', label: 'Board', icon: KanbanSquare, component: KanbanNode, defaultSize: { w: 860, h: 420 }, minSize: { w: 420, h: 240 } },
  { type: 'calendar', label: 'Calendar', icon: Calendar, component: CalendarNode, defaultSize: { w: 620, h: 460 }, minSize: { w: 380, h: 320 } },
  { type: 'note', label: 'Sticky note', icon: StickyNote, component: NoteNode, defaultSize: { w: 220, h: 200 }, minSize: { w: 120, h: 100 }, chromeless: true, create: () => ({ text: '', color: '#d4a72c' }) },
  { type: 'text', label: 'Text', icon: Type, component: TextNode, defaultSize: { w: 320, h: 60 }, minSize: { w: 60, h: 30 }, chromeless: true, create: () => ({ text: '' }) },
  { type: 'checklist', label: 'Checklist', icon: CheckSquare, component: ChecklistNode, defaultSize: { w: 300, h: 320 }, minSize: { w: 220, h: 160 }, create: () => ({ items: [] }) },
  { type: 'image', label: 'Image', icon: Image, component: ImageNode, defaultSize: { w: 480, h: 320 }, minSize: { w: 80, h: 60 }, chromeless: true },
  { type: 'git', label: 'Git', icon: GitBranch, component: GitNode, defaultSize: { w: 360, h: 460 }, minSize: { w: 300, h: 260 } },
  { type: 'file', label: 'File', icon: FileCode2, component: FileNode, defaultSize: { w: 560, h: 420 }, minSize: { w: 260, h: 160 } },
  { type: 'doc', label: 'Document', icon: FileText, component: DocNode, defaultSize: { w: 520, h: 640 }, minSize: { w: 300, h: 260 } },
  { type: 'plan', label: 'Plan', icon: ListChecks, component: PlanNode, defaultSize: { w: 320, h: 360 }, minSize: { w: 240, h: 180 } },
  { type: 'orchestrator', label: 'Orchestrator', icon: Network, component: OrchestratorNode, defaultSize: { w: 340, h: 420 }, minSize: { w: 280, h: 240 } }
]

export const NODE_DEFS = Object.fromEntries(defs.map((d) => [d.type, d])) as Record<NodeType, NodeDef>
