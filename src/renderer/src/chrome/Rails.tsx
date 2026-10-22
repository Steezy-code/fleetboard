import { useState } from 'react'
import {
  BookOpen,
  Bot,
  Brain,
  Calendar,
  CheckCheck,
  CheckSquare,
  Eraser,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  ImagePlus,
  KanbanSquare,
  LayoutGrid,
  MessagesSquare,
  MousePointer2,
  Network,
  PenLine,
  Plus,
  Radio,
  Repeat,
  Settings,
  Shapes,
  Sparkles,
  Spline,
  StickyNote,
  Type,
  Wand2,
  Workflow
} from 'lucide-react'
import { invoke, fileUrl } from '../lib/api'
import { useApp, type Tool } from '../state/store'
import { NODE_DEFS } from '../nodes/registry'
import type { NodeType } from '@shared/types'

function RailButton({ icon: Icon, title, active, onClick }: { icon: any; title: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`rail-btn ${active ? 'active' : ''}`} title={title} onClick={onClick}>
      <Icon size={16} />
    </button>
  )
}

export function addNodeOfType(type: NodeType, extra: Record<string, any> = {}) {
  const def = NODE_DEFS[type]
  const app = useApp.getState()
  const id = app.addNode({ type, w: def.defaultSize.w, h: def.defaultSize.h, data: { ...def.create?.(), ...extra } })
  app.setSelection([id])
  return id
}

async function addImage() {
  const path = await invoke<string | null>('dialog:openFile', [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }])
  if (!path) return
  const img = new Image()
  img.onload = () => {
    const s = Math.min(1, 640 / img.naturalWidth)
    const app = useApp.getState()
    app.addNode({ type: 'image', w: img.naturalWidth * s, h: img.naturalHeight * s, data: { path } })
  }
  img.src = fileUrl(path)
}

export function LeftRail() {
  const tool = useApp((s) => s.tool)
  const [addMenu, setAddMenu] = useState(false)
  const app = useApp.getState()
  const setTool = (t: Tool) => app.setTool(tool === t && t !== 'select' ? 'select' : t)
  const add = (type: NodeType) => {
    addNodeOfType(type)
    setAddMenu(false)
  }
  return (
    <div className="rail rail-left">
      <RailButton icon={MousePointer2} title="Select (V)" active={tool === 'select'} onClick={() => setTool('select')} />
      <RailButton icon={Bot} title="New console" onClick={() => app.openPanel('spawn')} />
      <div style={{ position: 'relative' }}>
        <RailButton icon={Plus} title="Add to board" active={addMenu} onClick={() => setAddMenu(!addMenu)} />
        {addMenu && (
          <div className="menu" style={{ left: 44, top: -6 }} onMouseLeave={() => setAddMenu(false)}>
            <div className="menu-label label">Add to board</div>
            <button className="menu-item" onClick={() => add('kanban')}>
              <KanbanSquare size={14} className="ic" /> Kanban board
            </button>
            <button className="menu-item" onClick={() => add('calendar')}>
              <Calendar size={14} className="ic" /> Calendar
            </button>
            <button className="menu-item" onClick={() => add('checklist')}>
              <CheckSquare size={14} className="ic" /> Checklist
            </button>
            <button className="menu-item" onClick={() => add('note')}>
              <StickyNote size={14} className="ic" /> Sticky note
            </button>
            <button className="menu-item" onClick={() => add('web')}>
              <Globe size={14} className="ic" /> Web tile
            </button>
            <button className="menu-item" onClick={() => add('git')}>
              <GitBranch size={14} className="ic" /> Git card
            </button>
            <button className="menu-item" onClick={() => add('orchestrator')}>
              <Network size={14} className="ic" /> Orchestrator
            </button>
            <button className="menu-item" onClick={() => (addImage(), setAddMenu(false))}>
              <ImagePlus size={14} className="ic" /> Image…
            </button>
          </div>
        )}
      </div>
      <RailButton icon={Shapes} title="Shapes (R)" active={tool === 'shape'} onClick={() => setTool('shape')} />
      <RailButton icon={Type} title="Text (T)" active={tool === 'text'} onClick={() => setTool('text')} />
      <RailButton icon={PenLine} title="Ink (P)" active={tool === 'pen'} onClick={() => setTool('pen')} />
      <RailButton icon={Eraser} title="Eraser (E)" active={tool === 'eraser'} onClick={() => setTool('eraser')} />
      <RailButton icon={StickyNote} title="Sticky note" onClick={() => add('note')} />
      <RailButton icon={Globe} title="Web tile" onClick={() => add('web')} />
      <RailButton icon={ImagePlus} title="Image" onClick={addImage} />
      <RailButton icon={Spline} title="Connect (wire two items)" active={tool === 'connector'} onClick={() => setTool('connector')} />
    </div>
  )
}

export function RightRail() {
  const [tools, setTools] = useState(false)
  const app = useApp.getState()
  const open = (name: string, props?: Record<string, any>) => {
    setTools(false)
    app.openPanel(name, props)
  }
  const drawer = (name: string) => {
    setTools(false)
    app.openDrawer(name)
  }
  return (
    <div className="rail rail-right">
      <RailButton icon={Network} title="Mission map" onClick={() => open('missionMap')} />
      <RailButton icon={Radio} title="Orchestrator" onClick={() => drawer('orchestrator')} />
      <div style={{ position: 'relative' }}>
        <RailButton icon={LayoutGrid} title="Tools" active={tools} onClick={() => setTools(!tools)} />
        {tools && (
          <div className="menu" style={{ right: 44, top: -6 }} onMouseLeave={() => setTools(false)}>
            <div className="menu-label label">Tools</div>
            <button className="menu-item" onClick={() => open('presets')}>
              <Sparkles size={14} className="ic" /> Presets
            </button>
            <button className="menu-item" onClick={() => drawer('git')}>
              <GitBranch size={14} className="ic" /> GitHub
            </button>
            <button className="menu-item" onClick={() => open('code')}>
              <FolderTree size={14} className="ic" /> Code
            </button>
            <button className="menu-item" onClick={() => open('markdown')}>
              <BookOpen size={14} className="ic" /> Markdown
            </button>
            <button className="menu-item" onClick={() => open('documents')}>
              <FileText size={14} className="ic" /> Documents
            </button>
            <button className="menu-item" onClick={() => open('diagrams')}>
              <Workflow size={14} className="ic" /> Diagrams
            </button>
            <button className="menu-item" onClick={() => open('missionMap')}>
              <Network size={14} className="ic" /> Mission Map
            </button>
            <button className="menu-item" onClick={() => open('memory')}>
              <Brain size={14} className="ic" /> Memory
            </button>
            <button className="menu-item" onClick={() => open('skills')}>
              <Wand2 size={14} className="ic" /> Skills
            </button>
            <button className="menu-item" onClick={() => open('loops')}>
              <Repeat size={14} className="ic" /> Loops
            </button>
            <button className="menu-item" onClick={() => drawer('chat')}>
              <MessagesSquare size={14} className="ic" /> Chat
            </button>
            <button className="menu-item" onClick={() => drawer('journal')}>
              <CheckCheck size={14} className="ic" /> Night log
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => open('settings')}>
              <Settings size={14} className="ic" /> Settings
            </button>
          </div>
        )}
      </div>
      <RailButton icon={FolderTree} title="Code studio" onClick={() => open('code')} />
      <RailButton icon={FileText} title="Document studio" onClick={() => open('documents')} />
      <RailButton icon={Workflow} title="Diagram studio" onClick={() => open('diagrams')} />
      <RailButton icon={BookOpen} title="Markdown vault" onClick={() => open('markdown')} />
      <RailButton icon={Repeat} title="Loops" onClick={() => open('loops')} />
    </div>
  )
}
