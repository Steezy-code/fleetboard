import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { BoardNode, NodeType } from '@shared/types'

export interface NodeProps<D = any> {
  node: BoardNode<D>
  selected: boolean
  /** current camera zoom (content can simplify itself when zoomed far out) */
  zoom: number
  /** rendered full-window via the maximize button */
  maximized: boolean
}

export interface NodeDef {
  type: NodeType
  label: string
  icon: LucideIcon
  component: ComponentType<NodeProps>
  /** replaces the default title in the header */
  header?: ComponentType<NodeProps>
  /** extra buttons placed before maximize/close */
  actions?: ComponentType<NodeProps>
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  /** no frame/header: the component draws everything and handles its own drag via .drag-handle */
  chromeless?: boolean
  /** return false to cancel removal (e.g. confirm killing a live console) */
  /** default data for a new node */
  create?: () => Record<string, any>
}
