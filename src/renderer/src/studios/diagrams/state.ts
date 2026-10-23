import { create } from 'zustand'
import { errorText, extractJson, invoke, runCli } from '../../lib/api'
import { activeWs, useApp } from '../../state/store'
import { buildDiagramPrompt } from './presets'
import { layoutDiagram } from './layout'
import { sanitizeSpec, type DiagramSpec } from './spec'
import { figureSize, layoutToInk, type DiagramStyle } from './toInk'
import { figureItems, figureTitle, figureToExcalidraw, figureToPngBase64 } from './export'
import { slugify } from '../docs/presets'
import { findFreeSpot, occupied, viewCentre } from '../../board/place'

interface DiagramStudioState {
  agentId: string | null
  style: DiagramStyle
  /** what is being drawn right now (button id), null when idle */
  busy: string | null
  busyLabel: string
  agentName: string
  activity: string
  lastFigureId: string | null
}

export const useDiagramStudio = create<DiagramStudioState>(() => ({
  agentId: null,
  style: 'ink',
  busy: null,
  busyLabel: '',
  agentName: 'Claude',
  activity: '',
  lastFigureId: null
}))

let cancelRun: (() => void) | null = null

/** Lay out a spec and spill it onto the board beside existing content; returns the figure id. */
export function placeDiagram(spec: DiagramSpec, style = useDiagramStudio.getState().style): string | null {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws) return null
  const layout = layoutDiagram(spec)
  const size = figureSize(layout)

  // as near the middle of the view as it fits without covering anything already there
  const origin = findFreeSpot(occupied(ws), size, viewCentre(app.viewport, ws.camera, size), 80)
  const items = layoutToInk(layout, origin, style)
  const figureId = items[0]?.figureId ?? null
  app.addInk(items)
  useDiagramStudio.setState({ lastFigureId: figureId })
  focusFigure(origin.x, origin.y, size.w, size.h)
  return figureId
}

/** Center the camera on a box, leaving room for the floating studio panel on the left. */
function focusFigure(x: number, y: number, w: number, h: number) {
  const app = useApp.getState()
  const vp = app.viewport
  const panelOpen = app.panel?.name === 'diagrams'
  const left = panelOpen ? 380 : 80
  const zoom = Math.max(0.2, Math.min(1, (vp.w - left - 100) / w, (vp.h - 240) / h))
  const shift = panelOpen ? (left - 80) / 2 / zoom : 0
  app.centerOn(x + w / 2 - shift, y + h / 2, zoom)
}

export function focusFigureId(figureId: string) {
  const ws = activeWs()
  if (!ws) return
  const items = figureItems(ws.ink, figureId)
  if (!items.length) return
  const l = Math.min(...items.map((i) => i.x))
  const t = Math.min(...items.map((i) => i.y))
  const r = Math.max(...items.map((i) => i.x + i.w))
  const b = Math.max(...items.map((i) => i.y + i.h))
  focusFigure(l, t, r - l, b - t)
  useApp.getState().setSelection(items.map((i) => i.id))
}

export async function generateDiagram(opts: { id: string; label: string; brief?: string; describe?: string; agentId: string; agentName: string }) {
  const app = useApp.getState()
  const project = app.project
  if (!project || useDiagramStudio.getState().busy) return
  useDiagramStudio.setState({ busy: opts.id, busyLabel: opts.label, agentName: opts.agentName, activity: 'Reading the repository…' })
  const prompt = buildDiagramPrompt({ brief: opts.brief, describe: opts.describe, projectName: project.name })
  const root = project.path.replace(/\/+$/, '') + '/'
  const run = runCli({ prompt, cwd: project.path, agentId: opts.agentId }, undefined, (line) =>
    useDiagramStudio.setState({ activity: line.split(root).join('').replace(/\s+/g, ' ').trim() })
  )
  let cancelled = false
  cancelRun = () => {
    cancelled = true
    run.cancel()
  }
  try {
    const res = await run.promise
    if (cancelled) return
    const spec = sanitizeSpec(extractJson(res.text))
    if (!spec) {
      app.toast(`${opts.agentName} did not return a diagram${res.text ? ': ' + res.text.trim().slice(0, 160) : '.'}`, 'error')
      return
    }
    if (useApp.getState().project?.id !== project.id) return
    placeDiagram(spec)
  } catch (e: any) {
    if (!cancelled) app.toast(`Diagram failed: ${errorText(e)}`, 'error')
  } finally {
    cancelRun = null
    useDiagramStudio.setState({ busy: null, activity: '' })
  }
}

export function stopDiagram() {
  cancelRun?.()
  useDiagramStudio.setState({ busy: null, activity: '' })
}

export async function exportPng(figureId: string) {
  const ws = activeWs()
  if (!ws) return
  const items = figureItems(ws.ink, figureId)
  if (!items.length) return
  const name = slugify(figureTitle(items))
  const path = await invoke<string | null>('dialog:saveFile', `${name}.png`, [{ name: 'PNG image', extensions: ['png'] }])
  if (!path) return
  try {
    await invoke('fs:writeBase64', path, await figureToPngBase64(items, 2))
    useApp.getState().toast('PNG exported', 'ok')
  } catch (e: any) {
    useApp.getState().toast(`PNG export failed: ${errorText(e)}`, 'error')
  }
}

export async function exportExcalidraw(figureId: string) {
  const ws = activeWs()
  if (!ws) return
  const items = figureItems(ws.ink, figureId)
  if (!items.length) return
  const name = slugify(figureTitle(items))
  const path = await invoke<string | null>('dialog:saveFile', `${name}.excalidraw`, [{ name: 'Excalidraw', extensions: ['excalidraw'] }])
  if (!path) return
  await invoke('fs:write', path, JSON.stringify(figureToExcalidraw(items), null, 2))
  useApp.getState().toast('Saved .excalidraw — open it at excalidraw.com or in any Excalidraw app', 'ok')
}
