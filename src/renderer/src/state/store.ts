import { create } from 'zustand'
import { findFreeSpot, occupied, viewCentre } from '../board/place'
import type {
  AgentAvailability,
  BoardNode,
  Camera,
  ConsoleStatus,
  Group,
  InkItem,
  NodeType,
  Project,
  ProjectMeta,
  Settings,
  Workspace
} from '@shared/types'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, mapWorkspaces } from '@shared/types'
import { errorText, invoke, request, uid } from '../lib/api'
import { baseName } from '../workbench/paths'
import { mayDropUnsaved } from '../lib/unsaved'
import { currentMotion } from '../ui/motion'
import { motionDuration } from '@shared/motion'

/**
 * Per-window memory that outlives the page (a crash, a reload) but not the app: sessionStorage belongs
 * to the window, not to the page's process. Missing or blocked storage just means nothing is remembered.
 */
const windowSession = {
  get: (key: string): string | null => {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, value)
    } catch {
      /* not remembered */
    }
  }
}
const OPEN_PROJECT = 'fleetboard.openProject'

export type Tool = 'select' | 'pen' | 'shape' | 'text' | 'eraser' | 'connector'

export interface PanelState {
  name: string
  props?: Record<string, any>
}

export interface Toast {
  id: string
  text: string
  tone?: 'info' | 'warn' | 'error' | 'ok'
  /** one button, such as Undo; the toast stays a little longer to give it a chance */
  action?: { label: string; run: () => void }
}

export interface ConfirmRequest {
  id: string
  title: string
  body?: string
  confirm?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface AppState {
  settings: Settings
  agents: AgentAvailability[]
  projects: ProjectMeta[]
  project: Project | null
  tool: Tool
  /** shape sub-tool for the shape tool */
  shapeKind: InkItem['kind']
  inkStyle: { stroke: string; width: number; fill?: string; opacity: number; dashed: boolean; sloppy: boolean; rounded: boolean }
  selection: string[]
  statuses: Record<string, ConsoleStatus>
  /** consoles with a live process in the main process */
  live: Record<string, boolean>
  /** the live ones whose process was started with auto-approval: what they do now, not the setting */
  approving: Record<string, boolean>
  /** node shown full-window (maximize button) */
  focusedNode: string | null
  panel: PanelState | null
  /** secondary floating panel on the right (usage, accounts, orchestrator, git) */
  drawer: PanelState | null
  toasts: Toast[]
  confirms: ConfirmRequest[]
  /** viewport size in px, kept by the board */
  viewport: { w: number; h: number }
  /** first end of a wire while the connector tool is active */
  wireFrom: string | null

  // app
  init: () => Promise<void>
  setSettings: (patch: Partial<Settings>) => Promise<void>
  refreshAgents: (force?: boolean) => Promise<void>
  openProject: (path: string) => Promise<void>
  closeProject: () => Promise<void>

  // workspaces
  addWorkspace: (name?: string) => string
  switchWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => void
  /** Flush pending saves and apply a previewed board after user confirmation. */
  recoverBoard: (token: string) => Promise<void>
  /** put back a closed workspace at the place it had (an Undo) */
  restoreWorkspace: (ws: Workspace, index: number) => void
  setProjectExtra: (key: string, value: any) => void
  setWsExtra: (key: string, value: any) => void

  // board items
  addNode: (n: Partial<BoardNode> & { type: NodeType }) => string
  updateNode: (id: string, patch: Partial<BoardNode>) => void
  updateNodeData: (id: string, patch: Record<string, any>) => void
  moveNodes: (ids: string[], dx: number, dy: number) => void
  removeNodes: (ids: string[]) => void
  bringToFront: (id: string) => void
  addGroup: (g: Partial<Group>) => string
  updateGroup: (id: string, patch: Partial<Group>) => void
  removeGroup: (id: string, withNodes?: boolean) => void
  fitGroup: (id: string) => void
  addWire: (from: string, to: string) => string
  removeWire: (id: string) => void
  addInk: (items: InkItem[]) => void
  updateInk: (id: string, patch: Partial<InkItem>) => void
  mutateWsById: (wsId: string, fn: (ws: Workspace) => Workspace) => void
  mutateEveryWs: (fn: (ws: Workspace) => Workspace) => void
  removeInk: (ids: string[]) => void

  // view
  setCamera: (c: Partial<Camera>) => void
  zoomAt: (factor: number, sx?: number, sy?: number) => void
  centerOn: (x: number, y: number, zoom?: number, animate?: boolean) => void
  /** fit a world rect in view (zoom window / zoom object) */
  zoomToRect: (r: { x: number; y: number; w: number; h: number }, pad?: number, maxZoom?: number) => void
  /** go back to the view before the last fit / focus / zoom window; false if there is none */
  zoomPrevious: () => boolean
  fitAll: () => void
  focusItem: (id: string) => void
  setTool: (t: Tool) => void
  setSelection: (ids: string[]) => void
  /** null exits focus mode; an id enters it (kept for existing callers) */
  setFocusedNode: (id: string | null) => void
  /** Focus mode: glide into a node so it fills the board at 100%, remembering the current view */
  enterFocus: (id: string) => void
  /** Leave focus mode and glide back to the view saved on entry */
  exitFocus: () => void
  /** Hop to the previous/next console on this workspace without leaving focus */
  cycleFocus: (dir: 1 | -1) => void
  /** internal: removes nodes without focus bookkeeping */
  _removeNodes: (ids: string[]) => void
  openPanel: (name: string, props?: Record<string, any>) => void
  closePanel: () => void
  openDrawer: (name: string, props?: Record<string, any>) => void
  closeDrawer: () => void
  toast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void
  confirm: (req: Omit<ConfirmRequest, 'id' | 'resolve'>) => Promise<boolean>
  setStatus: (id: string, s: ConsoleStatus) => void
  setLive: (id: string, live: boolean, autoApproves?: boolean) => void
}

export const newWorkspace = (name: string): Workspace => ({
  id: uid('ws'),
  name,
  nodes: [],
  groups: [],
  wires: [],
  ink: [],
  camera: { x: 0, y: 0, zoom: 1 },
  extras: {}
})

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

// "Zoom Previous": views saved before each fit / focus / zoom window, per workspace.
const viewHistory = new Map<string, Camera[]>()
export function pushView(wsId: string, cam: Camera) {
  const stack = viewHistory.get(wsId) ?? []
  const last = stack[stack.length - 1]
  if (last && Math.abs(last.x - cam.x) < 1 && Math.abs(last.y - cam.y) < 1 && last.zoom === cam.zoom) return
  stack.push({ ...cam })
  if (stack.length > 40) stack.shift()
  viewHistory.set(wsId, stack)
}

// Smooth camera moves. Zoom interpolates in log space so it feels even at every scale.
let animFrame = 0
export function animateCamera(target: Camera, ms = 260) {
  stopCameraAnimation()
  const ws = activeWs()
  if (!ws) return
  const level = currentMotion()
  if (level === 'off') return useApp.getState().setCamera(target)
  ms = Math.min(ms, motionDuration(level))
  const from = { ...ws.camera }
  const vp = useApp.getState().viewport
  // animate the world point at the viewport center, so the move doesn't swing sideways
  const cx = vp.w / 2
  const cy = vp.h / 2
  const fromWorld = { x: (cx - from.x) / from.zoom, y: (cy - from.y) / from.zoom }
  const toWorld = { x: (cx - target.x) / target.zoom, y: (cy - target.y) / target.zoom }
  const lz0 = Math.log(from.zoom)
  const lz1 = Math.log(target.zoom)
  const t0 = performance.now()
  const ease = (t: number) => 1 - Math.pow(1 - t, 3)
  const step = (now: number) => {
    if (activeWs()?.id !== ws.id) return stopCameraAnimation()
    if (currentMotion() === 'off') {
      stopCameraAnimation()
      return useApp.getState().setCamera(target)
    }
    const t = Math.min(1, (now - t0) / ms)
    const k = ease(t)
    const zoom = Math.exp(lz0 + (lz1 - lz0) * k)
    const wx = fromWorld.x + (toWorld.x - fromWorld.x) * k
    const wy = fromWorld.y + (toWorld.y - fromWorld.y) * k
    useApp.getState().setCamera(t === 1 ? target : { zoom, x: cx - wx * zoom, y: cy - wy * zoom })
    if (t < 1) animFrame = requestAnimationFrame(step)
  }
  animFrame = requestAnimationFrame(step)
  // rAF stops while the window is hidden or occluded: make sure the move still lands
  const token = ++animToken
  window.clearTimeout(animFallback)
  animFallback = window.setTimeout(() => {
    if (token !== animToken || activeWs()?.id !== ws.id) return
    cancelAnimationFrame(animFrame)
    const c = activeWs()?.camera
    if (c && (c.x !== target.x || c.y !== target.y || c.zoom !== target.zoom)) useApp.getState().setCamera(target)
  }, ms + 120)
}
let animToken = 0
let animFallback = 0
export const stopCameraAnimation = () => {
  animToken++
  window.clearTimeout(animFallback)
  cancelAnimationFrame(animFrame)
}

/** Focus mode geometry: the node fills the board below the top bar with a small margin. */
export const FOCUS_MS = 420
export function focusRect(vp: { w: number; h: number }) {
  const top = 58
  return { x: 16, y: top, w: Math.max(320, vp.w - 32), h: Math.max(200, vp.h - top - 16) }
}

/** Put the camera back to the pre-focus view right away (no animation), e.g. before leaving a workspace. */
function restoreFocusInstantly() {
  const app = useApp.getState()
  const ws = activeWs()
  const saved = ws?.extras.focusReturn as Camera | undefined
  if (app.focusedNode || saved) {
    stopCameraAnimation()
    if (saved) {
      app.setCamera(saved)
      app.setWsExtra('focusReturn', undefined)
    }
    useApp.setState({ focusedNode: null })
  }
}

function clearFocusReturn(w: Workspace): Workspace {
  const saved = w.extras?.focusReturn as Camera | undefined
  if (!saved) return w
  const { focusReturn: _f, ...extras } = w.extras
  return { ...w, camera: saved, extras }
}

let saveTimer: number | undefined
let saveWarnedAt = 0
/**
 * Drop a save that is still waiting out its debounce. Only for the paths that save straight away:
 * the pending timer holds an older snapshot of the project and would write it back over the newer
 * one.
 */
function cancelScheduledSave() {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
}
function scheduleSave(p: Project | null) {
  if (!p) return
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(
    () =>
      request('store:saveProject', p).catch((e) => {
        // a board that silently stops saving loses everything done since: say so (not on every change)
        console.error('saving the board failed', e)
        if (Date.now() - saveWarnedAt < 30_000) return
        saveWarnedAt = Date.now()
        useApp.getState().toast(`Could not save the board: ${errorText(e)}`, 'warn')
      }),
    350
  )
}

export const useApp = create<AppState>((set, get) => {
  /** Apply a change to the active workspace and persist. */
  const mutateWs = (fn: (ws: Workspace) => Workspace) => {
    const p = get().project
    if (!p) return
    const workspaces = mapWorkspaces(p, (w) => (w.id === p.activeWorkspaceId ? fn(w) : w))
    const project = { ...p, workspaces }
    set({ project })
    scheduleSave(project)
  }
  /**
   * Apply a change to one workspace by id — the active one or any other — and persist.
   *
   * Without this there was no way to change a workspace that is not the active one, and four places
   * invented their own: a bare useApp.setState, which changes live state and schedules nothing. Two
   * of them then wrote a junk `fleetTouched` timestamp into every saved board to trigger the save;
   * the other two scheduled nothing at all.
   */
  const mutateWsById = (wsId: string, fn: (ws: Workspace) => Workspace) => {
    const p = get().project
    if (!p) return
    const project = { ...p, workspaces: mapWorkspaces(p, (w) => (w.id === wsId ? fn(w) : w)) }
    set({ project })
    scheduleSave(project)
  }
  const mutateProject = (fn: (p: Project) => Project) => {
    const p = get().project
    if (!p) return
    const project = fn(p)
    set({ project })
    scheduleSave(project)
  }
  const maxZ = (ws: Workspace) => ws.nodes.reduce((m, n) => Math.max(m, n.z), 0)

  return {
    settings: DEFAULT_SETTINGS,
    agents: [],
    projects: [],
    project: null,
    tool: 'select',
    shapeKind: 'rect',
    inkStyle: { stroke: '#ff4a2b', width: 3, opacity: 1, dashed: false, sloppy: true, rounded: true },
    selection: [],
    statuses: {},
    live: {},
    approving: {},
    focusedNode: null,
    panel: null,
    drawer: null,
    toasts: [],
    confirms: [],
    viewport: { w: window.innerWidth, h: window.innerHeight },
    wireFrom: null,

    init: async () => {
      const [settings, projects] = await Promise.all([request('store:settings'), invoke<ProjectMeta[]>('store:projects')])
      set({ settings: { ...DEFAULT_SETTINGS, ...settings }, projects })
      get().refreshAgents()
      const live = await request('pty:list')
      set({
        live: Object.fromEntries(live.map((l) => [l.id, true])),
        approving: Object.fromEntries(live.filter((l) => l.autoApproves).map((l) => [l.id, true])),
        statuses: Object.fromEntries(live.map((l) => [l.id, l.status]))
      })
      // the page was reloaded (after a crash, or by hand): back to the board it showed
      const reopen = windowSession.get(OPEN_PROJECT)
      if (reopen && !get().project) await get().openProject(reopen)
      if (await invoke<boolean>('app:crashRecovered').catch(() => false))
        get().toast(`The window crashed and was reloaded.${live.length ? ' Your consoles kept running.' : ''}`, 'warn')
    },
    setSettings: async (patch) => {
      const settings = await request('store:setSettings', patch)
      set({ settings })
    },
    refreshAgents: async (force) => set({ agents: await request('agents:detect', force) }),

    openProject: async (path) => {
      // from a playbook or by voice as well as the home screen: an editor's unsaved work goes only if the user says so
      if (get().project && get().project!.path !== path && !(await mayDropUnsaved('Open another project'))) return
      const id = await request('store:projectId', path)
      // null means there is no board for this folder yet. A *refusal* means there is one and this
      // build must not touch it — opening a blank board over that id would be a board that can never
      // save, so stay where we are and say why.
      const loaded = await request('store:loadProject', id).catch((e) => {
        get().toast(errorText(e), 'warn')
        return undefined
      })
      if (loaded === undefined) return
      let project = loaded
      if (!project) {
        const ws = newWorkspace('Workspace 1')
        project = {
          schema: SCHEMA_VERSION,
          id,
          name: baseName(path),
          path,
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          lastOpened: Date.now(),
          extras: {}
        }
      }
      project = { ...project, path, lastOpened: Date.now() }
      // quit while focused: come back at the view from before focusing
      project = { ...project, workspaces: mapWorkspaces(project, clearFocusReturn) }
      // the board being replaced is saved now: its pending save would be cancelled by the new one's
      const previous = get().project
      if (previous && previous.id !== project.id) {
        cancelScheduledSave()
        void request('store:saveProject', previous)
      }
      set({ project, selection: [], panel: null, drawer: null, focusedNode: null })
      scheduleSave(project)
      windowSession.set(OPEN_PROJECT, path)
    },
    recoverBoard: async (token) => {
      if (!(await mayDropUnsaved('Replace the board'))) return
      const previous = get().project
      if (!previous) return
      cancelScheduledSave()
      await request('store:saveProject', previous)
      if (get().project !== previous) throw new Error('The board changed during recovery; preview it again')
      cancelScheduledSave()
      const project = await request('recovery:apply', token)
      if (get().project?.id !== previous.id) return
      set({ project, selection: [], focusedNode: null, panel: null, drawer: null })
    },
    closeProject: async () => {
      if (!(await mayDropUnsaved('Close the project'))) return
      windowSession.set(OPEN_PROJECT, null)
      restoreFocusInstantly()
      const p = get().project
      cancelScheduledSave()
      if (p) request('store:saveProject', p)
      set({ project: null, selection: [], panel: null, drawer: null, focusedNode: null })
      invoke<ProjectMeta[]>('store:projects').then((projects) => set({ projects }))
    },

    addWorkspace: (name) => {
      const p = get().project!
      const ws = newWorkspace(name ?? `Workspace ${p.workspaces.length + 1}`)
      mutateProject((p) => ({ ...p, workspaces: [...p.workspaces, ws], activeWorkspaceId: ws.id }))
      set({ selection: [] })
      return ws.id
    },
    switchWorkspace: (id) => {
      restoreFocusInstantly()
      mutateProject((p) => ({ ...p, activeWorkspaceId: id }))
      set({ selection: [], focusedNode: null })
    },
    renameWorkspace: (id, name) =>
      mutateProject((p) => ({ ...p, workspaces: mapWorkspaces(p, (w) => (w.id === id ? { ...w, name } : w)) })),
    closeWorkspace: (id) =>
      mutateProject((p) => {
        const [kept, ...rest] = p.workspaces.filter((w) => w.id !== id)
        // closing the last workspace leaves a fresh empty one, never a board with none
        const workspaces: [Workspace, ...Workspace[]] = kept ? [kept, ...rest] : [newWorkspace('Workspace 1')]
        const activeWorkspaceId = p.activeWorkspaceId === id ? workspaces[0].id : p.activeWorkspaceId
        return { ...p, workspaces, activeWorkspaceId }
      }),
    restoreWorkspace: (ws, index) =>
      mutateProject((p) => {
        if (p.workspaces.some((w) => w.id === ws.id)) return p
        const list = [...p.workspaces]
        list.splice(Math.min(Math.max(0, index), list.length), 0, ws)
        return { ...p, workspaces: list as [Workspace, ...Workspace[]] }
      }),
    setProjectExtra: (key, value) => mutateProject((p) => ({ ...p, extras: { ...p.extras, [key]: value } })),
    setWsExtra: (key, value) => mutateWs((w) => ({ ...w, extras: { ...w.extras, [key]: value } })),

    addNode: (n) => {
      const id = n.id ?? uid(n.type.slice(0, 3))
      mutateWs((ws) => {
        const vp = get().viewport
        const cam = ws.camera
        const w = n.w ?? 480
        const h = n.h ?? 320
        // default position: as near the middle of the view as it can be without covering anything
        const spot = n.x === undefined || n.y === undefined ? findFreeSpot(occupied(ws), { w, h }, viewCentre(vp, cam, { w, h })) : null
        const x = n.x ?? spot!.x
        const y = n.y ?? spot!.y
        const node: BoardNode = { data: {}, ...n, id, x, y, w, h, z: maxZ(ws) + 1 }
        return { ...ws, nodes: [...ws.nodes, node] }
      })
      return id
    },
    updateNode: (id, patch) =>
      mutateWs((ws) => ({ ...ws, nodes: ws.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),
    // in whichever workspace holds the node: consoles in the background report too (a new session id)
    updateNodeData: (id, patch) => {
      const p = get().project
      if (!p?.workspaces.some((w) => w.nodes.some((n) => n.id === id))) return
      mutateProject((p) => ({
        ...p,
        workspaces: mapWorkspaces(p, (w) =>
          w.nodes.some((n) => n.id === id) ? { ...w, nodes: w.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) } : w
        )
      }))
    },
    moveNodes: (ids, dx, dy) =>
      mutateWs((ws) => {
        const set = new Set(ids)
        return {
          ...ws,
          nodes: ws.nodes.map((n) => (set.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
          groups: ws.groups.map((g) => (set.has(g.id) ? { ...g, x: g.x + dx, y: g.y + dy } : g)),
          ink: ws.ink.map((i) =>
            set.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy, points: i.points?.map(([px, py]) => [px + dx, py + dy] as [number, number]) } : i
          )
        }
      }),
    removeNodes: (ids) => {
      if (get().focusedNode && ids.includes(get().focusedNode!)) get().exitFocus()
      get()._removeNodes(ids)
    },
    _removeNodes: (ids: string[]) =>
      mutateWs((ws) => {
        const s = new Set(ids)
        return {
          ...ws,
          nodes: ws.nodes.filter((n) => !s.has(n.id)),
          wires: ws.wires.filter((w) => !s.has(w.from) && !s.has(w.to)),
          ink: ws.ink.filter((i) => !s.has(i.id)),
          groups: ws.groups.filter((g) => !s.has(g.id))
        }
      }),
    bringToFront: (id) =>
      mutateWs((ws) => {
        const top = maxZ(ws)
        const n = ws.nodes.find((x) => x.id === id)
        if (!n || n.z === top) return ws
        return { ...ws, nodes: ws.nodes.map((x) => (x.id === id ? { ...x, z: top + 1 } : x)) }
      }),

    addGroup: (g) => {
      const id = g.id ?? uid('grp')
      mutateWs((ws) => ({
        ...ws,
        groups: [...ws.groups, { name: 'Team', role: 'General', x: 0, y: 0, w: 600, h: 400, ...g, id }]
      }))
      return id
    },
    updateGroup: (id, patch) => mutateWs((ws) => ({ ...ws, groups: ws.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
    removeGroup: (id, withNodes) =>
      mutateWs((ws) => ({
        ...ws,
        groups: ws.groups.filter((g) => g.id !== id),
        wires: ws.wires.filter((w) => w.from !== id && w.to !== id),
        nodes: withNodes ? ws.nodes.filter((n) => n.groupId !== id) : ws.nodes.map((n) => (n.groupId === id ? { ...n, groupId: undefined } : n))
      })),
    fitGroup: (id) =>
      mutateWs((ws) => {
        const members = ws.nodes.filter((n) => n.groupId === id)
        if (!members.length) return ws
        const pad = 24
        const x = Math.min(...members.map((n) => n.x)) - pad
        const y = Math.min(...members.map((n) => n.y)) - pad - 34
        const r = Math.max(...members.map((n) => n.x + n.w)) + pad
        const b = Math.max(...members.map((n) => n.y + n.h)) + pad
        return { ...ws, groups: ws.groups.map((g) => (g.id === id ? { ...g, x, y, w: r - x, h: b - y } : g)) }
      }),
    addWire: (from, to) => {
      const id = uid('wire')
      mutateWs((ws) =>
        ws.wires.some((w) => (w.from === from && w.to === to) || (w.from === to && w.to === from))
          ? ws
          : { ...ws, wires: [...ws.wires, { id, from, to }] }
      )
      return id
    },
    removeWire: (id) => mutateWs((ws) => ({ ...ws, wires: ws.wires.filter((w) => w.id !== id) })),
    addInk: (items) => mutateWs((ws) => ({ ...ws, ink: [...ws.ink, ...items] })),
    updateInk: (id, patch) => mutateWs((ws) => ({ ...ws, ink: ws.ink.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    mutateWsById,
    mutateEveryWs: (fn) => mutateProject((p) => ({ ...p, workspaces: mapWorkspaces(p, fn) })),
    removeInk: (ids) => {
      const s = new Set(ids)
      mutateWs((ws) => ({ ...ws, ink: ws.ink.filter((i) => !s.has(i.id)) }))
    },

    setCamera: (c) => mutateWs((ws) => ({ ...ws, camera: { ...ws.camera, ...c } })),
    zoomAt: (factor, sx, sy) =>
      mutateWs((ws) => {
        const vp = get().viewport
        const cx = sx ?? vp.w / 2
        const cy = sy ?? vp.h / 2
        const cam = ws.camera
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor))
        const k = zoom / cam.zoom
        return { ...ws, camera: { zoom, x: cx - (cx - cam.x) * k, y: cy - (cy - cam.y) * k } }
      }),
    centerOn: (x, y, zoom, animate = true) => {
      const ws = activeWs()
      if (!ws) return
      const vp = get().viewport
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom ?? ws.camera.zoom))
      const target = { zoom: z, x: vp.w / 2 - x * z, y: vp.h / 2 - y * z }
      pushView(ws.id, ws.camera)
      if (animate) animateCamera(target)
      else get().setCamera(target)
    },
    zoomToRect: (r, pad = 60, maxZoom = 1.6) => {
      const vp = get().viewport
      const w = Math.max(r.w, 1)
      const h = Math.max(r.h, 1)
      // leave room for the top bar, rails and the bottom bar
      const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((vp.w - 120 - pad * 2) / w, (vp.h - 230 - pad * 2) / h)))
      get().centerOn(r.x + w / 2, r.y + h / 2 + 40 / zoom, zoom)
    },
    zoomPrevious: () => {
      const ws = activeWs()
      if (!ws) return false
      const stack = viewHistory.get(ws.id)
      const prev = stack?.pop()
      if (!prev) return false
      animateCamera(prev)
      return true
    },
    fitAll: () => {
      const ws = activeWs()
      if (!ws) return
      const boxes = occupied(ws)
      if (!boxes.length) return get().centerOn(0, 0, 1)
      const l = Math.min(...boxes.map((b) => b.x))
      const t = Math.min(...boxes.map((b) => b.y))
      const r = Math.max(...boxes.map((b) => b.x + b.w))
      const b = Math.max(...boxes.map((b) => b.y + b.h))
      get().zoomToRect({ x: l, y: t, w: r - l, h: b - t }, 40, 1.2)
    },
    focusItem: (id) => {
      const ws = activeWs()
      const item = ws?.nodes.find((n) => n.id === id) ?? ws?.groups.find((g) => g.id === id)
      if (!item) return
      get().zoomToRect(item, 40, 1.1)
      set({ selection: [id] })
    },
    setTool: (tool) => set({ tool }),
    setSelection: (selection) => set({ selection }),
    setFocusedNode: (id) => (id ? get().enterFocus(id) : get().exitFocus()),
    enterFocus: (id) => {
      const ws = activeWs()
      const node = ws?.nodes.find((n) => n.id === id)
      if (!ws || !node) return
      stopCameraAnimation()
      // remember where the user was only when first entering, not when hopping between nodes
      if (!get().focusedNode || !ws.extras.focusReturn) get().setWsExtra('focusReturn', { ...ws.camera })
      set({ focusedNode: id, selection: [id] })
      const r = focusRect(get().viewport)
      animateCamera({ zoom: 1, x: r.x - node.x, y: r.y - node.y }, FOCUS_MS)
    },
    exitFocus: () => {
      const ws = activeWs()
      const saved = ws?.extras.focusReturn as Camera | undefined
      set({ focusedNode: null })
      if (saved) {
        get().setWsExtra('focusReturn', undefined)
        animateCamera(saved, FOCUS_MS)
      }
    },
    cycleFocus: (dir) => {
      const ws = activeWs()
      const current = get().focusedNode
      if (!ws || !current) return
      const order = ws.nodes.filter((n) => n.type === 'console' || n.id === current).sort((a, b) => a.y - b.y || a.x - b.x)
      const i = order.findIndex((n) => n.id === current)
      const next = order[(i + dir + order.length) % order.length]
      if (next && next.id !== current) get().enterFocus(next.id)
    },
    openPanel: (name, props) => set({ panel: { name, props } }),
    closePanel: () => set({ panel: null }),
    openDrawer: (name, props) => set((s) => ({ drawer: s.drawer?.name === name && !props ? null : { name, props } })),
    closeDrawer: () => set({ drawer: null }),
    toast: (text, tone = 'info', action) => {
      const id = uid('t')
      set((s) => ({ toasts: [...s.toasts, { id, text, tone, ...(action ? { action } : {}) }] }))
      window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 9000 : 4200)
    },
    confirm: (req) =>
      new Promise<boolean>((resolve) => {
        const id = uid('c')
        set((s) => ({
          confirms: [
            ...s.confirms,
            {
              ...req,
              id,
              resolve: (ok) => {
                set((st) => ({ confirms: st.confirms.filter((c) => c.id !== id) }))
                resolve(ok)
              }
            }
          ]
        }))
      }),
    setStatus: (id, s) => set((st) => (st.statuses[id] === s ? st : { statuses: { ...st.statuses, [id]: s } })),
    setLive: (id, live, autoApproves = false) =>
      set((st) => {
        const next = { ...st.live }
        const approving = { ...st.approving }
        if (live) next[id] = true
        else delete next[id]
        if (live && autoApproves) approving[id] = true
        else delete approving[id]
        return { live: next, approving }
      })
  }
})

/** The active workspace (non-reactive read). */
export const activeWs = (): Workspace | null => {
  const p = useApp.getState().project
  return p?.workspaces.find((w) => w.id === p.activeWorkspaceId) ?? null
}

/** Reactive hook for the active workspace. */
export const useWs = <T,>(sel: (ws: Workspace) => T): T | undefined =>
  useApp((s) => {
    const p = s.project
    const ws = p?.workspaces.find((w) => w.id === p.activeWorkspaceId)
    return ws ? sel(ws) : undefined
  })

/** Every console node across every workspace of the open project. */
export const allConsoles = (): (BoardNode & { workspaceId: string })[] => {
  const p = useApp.getState().project
  if (!p) return []
  return p.workspaces.flatMap((w) => w.nodes.filter((n) => n.type === 'console').map((n) => ({ ...n, workspaceId: w.id })))
}

export const screenToWorld = (sx: number, sy: number) => {
  const cam = activeWs()?.camera ?? { x: 0, y: 0, zoom: 1 }
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom }
}

/** Connector tool: first click picks the source, second click the target. */
export function connectClick(id: string) {
  const s = useApp.getState()
  if (!s.wireFrom) {
    useApp.setState({ wireFrom: id })
    s.toast('Now click the item to connect to')
  } else if (s.wireFrom !== id) {
    s.addWire(s.wireFrom, id)
    useApp.setState({ wireFrom: null, tool: 'select' })
  }
}
