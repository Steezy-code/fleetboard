import { isTypingTarget } from '../lib/typing'
import type { Workspace } from '@shared/types'
import { offscreen } from './visibility'
import { useEffect, useRef, useState } from 'react'
import { offerGoal, useGoalIdeas } from '../chrome/goalIdeas'
import { useApp, screenToWorld, activeWs, stopCameraAnimation, MAX_ZOOM, focusRect } from '../state/store'
import { NodeFrame } from './NodeFrame'
import { deleteSelection } from './deleteSelection'
import { mayDropUnsaved } from '../lib/unsaved'
import { GroupFrame } from './GroupFrame'
import { Wires } from './Wires'
import { WirePreview } from './WirePreview'
import { InkLayer } from './InkLayer'
import { intersects } from './geometry'
import { compactAtZoom } from '@shared/motion'
import { selectionPulse } from '../ui/selectionMotion'
import { groupBox, hiddenIds } from './place'
import { fileUrl, request } from '../lib/api'

const within = (box: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }) =>
  r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h

/** The box around everything selected, in board coordinates, so it pans and zooms with them. */
function selectionBox(ws: Workspace, selection: string[]) {
  const picked = selection.length > 1 ? new Set(selection) : null
  if (!picked) return null
  const boxes = [
    ...ws.nodes.filter((n) => picked.has(n.id)),
    ...ws.ink.filter((i) => picked.has(i.id)),
    ...ws.groups.filter((g) => picked.has(g.id)).map(groupBox)
  ]
  if (boxes.length < 2) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

/** Zoom Object: fit the current selection. */
export function zoomToSelection() {
  const app = useApp.getState()
  const ws = activeWs()
  if (!ws) return
  const items = [...ws.nodes, ...ws.groups, ...ws.ink].filter((i) => app.selection.includes(i.id))
  if (!items.length) return app.toast('Select something to zoom to')
  const l = Math.min(...items.map((b) => b.x))
  const t = Math.min(...items.map((b) => b.y))
  const r = Math.max(...items.map((b) => b.x + b.w))
  const b = Math.max(...items.map((b) => b.y + b.h))
  app.zoomToRect({ x: l, y: t, w: r - l, h: b - t }, 40, 1.4)
}

const isTyping = isTypingTarget

export function Board() {
  const ref = useRef<HTMLDivElement>(null)
  const project = useApp((s) => s.project)
  const ws = project?.workspaces.find((w) => w.id === project.activeWorkspaceId)
  const viewport = useApp((s) => s.viewport)
  const selection = useApp((s) => s.selection)
  const focusedNode = useApp((s) => s.focusedNode)
  const tool = useApp((s) => s.tool)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number; mode: 'window' | 'crossing' | 'zoom' } | null>(null)
  const [panning, setPanning] = useState(false)
  // Cards drop to compact labels when they are too small to read. State, not a style read per frame:
  // it only changes when a threshold is crossed, so zooming does not rerender the board every frame.
  const [compact, setCompact] = useState(false)
  const settingsNav = useApp((s) => s.settings.navigation)
  // AutoCAD-style command line: 'zoom' waits for E/P/W/O, 'window' waits for a drag
  const [cmd, setCmdState] = useState<'zoom' | 'window' | null>(null)
  const cmdRef = useRef<typeof cmd>(null)
  const setCmd = (c: typeof cmd | ((c: typeof cmd) => typeof cmd)) => {
    const next = typeof c === 'function' ? c(cmdRef.current) : c
    cmdRef.current = next
    setCmdState(next)
  }

  // The board never scrolls: focusing an input or terminal inside the zoomed world makes Chromium
  // scroll this overflow-hidden container to "reveal" it, which shifts everything. Undo that at once.
  useEffect(() => {
    const el = ref.current!
    const pin = () => {
      if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0)
    }
    el.addEventListener('scroll', pin)
    return () => el.removeEventListener('scroll', pin)
  }, [])

  // Compact labels below the zoom threshold, detail back above it. Hysteresis lives in
  // compactAtZoom: a single threshold flickers the whole board while a trackpad hovers on it.
  const zoom = ws?.camera.zoom ?? 1
  useEffect(() => setCompact((was) => compactAtZoom(zoom, was)), [zoom])

  // A second item joining the selection is acknowledged once; the shared boundary is drawn below.
  const selectionKey = selection.join(',')
  const selectedCount = useRef(0)
  useEffect(() => {
    const ids = selectionKey ? selectionKey.split(',') : []
    const grew = ids.length >= 2 && ids.length > selectedCount.current
    selectedCount.current = ids.length
    if (!grew) return
    return selectionPulse(ids)
  }, [selectionKey])

  // viewport size
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => useApp.setState({ viewport: { w: el.clientWidth, h: el.clientHeight } }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Wheel. CAD navigation (default, like AutoCAD): the wheel zooms at the cursor, Shift+wheel pans
  // sideways, Alt+wheel pans up/down. Trackpad navigation: the wheel pans, Ctrl+wheel/pinch zooms.
  // Content that scrolls (terminals, lists) keeps its wheel unless Ctrl is held.
  useEffect(() => {
    const el = ref.current!
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement
      const ctrl = e.ctrlKey || e.metaKey
      if (useApp.getState().focusedNode) {
        // focused: the content keeps its wheel; Ctrl+scroll out is the "zoom back out" gesture
        if (ctrl) {
          e.preventDefault()
          if (e.deltaY > 0) useApp.getState().exitFocus()
        } else if (!target.closest('.node.focused, .modal, .drawer, .menu, .inbox')) e.preventDefault()
        return
      }
      if (!ctrl && target.closest('.no-board-wheel, .scrollable, .modal, .drawer, .menu')) return
      e.preventDefault()
      stopCameraAnimation()
      const app = useApp.getState()
      const cam = activeWs()?.camera
      if (!cam) return
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1
      const dx = e.deltaX * unit
      const dy = e.deltaY * unit
      const r = el.getBoundingClientRect()
      const cad = app.settings.navigation !== 'trackpad'
      if (ctrl || (cad && !e.shiftKey && !e.altKey)) {
        app.zoomAt(Math.exp(-dy * (ctrl && !cad ? 0.0022 : 0.0016)), e.clientX - r.left, e.clientY - r.top)
      } else if (cad) {
        if (e.shiftKey) app.setCamera({ x: cam.x - (dx || dy) })
        else app.setCamera({ y: cam.y - dy, x: cam.x - dx })
      } else {
        const hx = e.shiftKey && !dx ? dy : dx
        const hy = e.shiftKey && !dx ? 0 : dy
        app.setCamera({ x: cam.x - hx, y: cam.y - hy })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Middle button: drag to pan from anywhere (even over consoles), double-click for Zoom Extents.
  useEffect(() => {
    const el = ref.current!
    let lastMiddle = 0
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1 || useApp.getState().focusedNode) return
      e.preventDefault()
      e.stopPropagation()
      stopCameraAnimation()
      const now = Date.now()
      if (now - lastMiddle < 350) {
        lastMiddle = 0
        useApp.getState().fitAll()
        return
      }
      lastMiddle = now
      const app = useApp.getState()
      const start = { ...activeWs()!.camera }
      const sx = e.clientX
      const sy = e.clientY
      el.setPointerCapture(e.pointerId)
      setPanning(true)
      const move = (ev: PointerEvent) => app.setCamera({ x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy })
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        setPanning(false)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    }
    // stop Linux middle-click paste and autoscroll on the board
    const noMiddle = (e: MouseEvent) => e.button === 1 && e.preventDefault()
    el.addEventListener('pointerdown', onDown, { capture: true })
    el.addEventListener('mousedown', noMiddle, { capture: true })
    el.addEventListener('auxclick', noMiddle, { capture: true })
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true })
      el.removeEventListener('mousedown', noMiddle, { capture: true })
      el.removeEventListener('auxclick', noMiddle, { capture: true })
    }
  }, [])

  // keyboard (including AutoCAD-style "Z" zoom commands: Z E, Z P, Z W, Z O)
  useEffect(() => {
    let chordTimer = 0
    const endChord = () => {
      window.clearTimeout(chordTimer)
      setCmd((c) => (c === 'zoom' ? null : c))
    }
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState()
      if (isTyping(e.target)) return // Esc inside a terminal belongs to the CLI
      // a dialog's keys are the dialog's: Escape on "close without saving?" means no, not also
      // "close the studio behind it"
      if (e.defaultPrevented || app.confirms.length) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (cmdRef.current === 'zoom' && !mod && !e.altKey) {
        e.preventDefault()
        endChord()
        if (key === 'e' || key === 'a') app.fitAll()
        else if (key === 'p') !app.zoomPrevious() && app.toast('No previous view')
        else if (key === 'w') setCmd('window')
        else if (key === 'o' || key === 's') zoomToSelection()
        return
      }
      if (cmdRef.current === 'window' && e.key === 'Escape') return setCmd(null)

      // only when the board itself has the keys: not over a panel or drawer, not from a button in the
      // chrome, and not right after Escape left a note's editor (focus is then on the page, not a tile)
      const onBoard = e.target === document.body || (e.target instanceof Node && !!ref.current?.contains(e.target))
      if ((e.key === 'Delete' || e.key === 'Backspace') && app.selection.length && onBoard && !app.panel && !app.drawer) {
        e.preventDefault()
        void deleteSelection()
      } else if (e.key === 'Escape') {
        if (app.focusedNode) app.setFocusedNode(null)
        // through the same question as the panel's own close: an editor in it may have unsaved edits
        else if (app.panel) void mayDropUnsaved('Close').then((ok) => ok && useApp.getState().closePanel())
        else {
          app.setSelection([])
          // setTool drops a half-made wire with the tool; Escape on the connector alone also disarms it
          app.setTool('select')
        }
      } else if (e.key === 'Home') {
        app.fitAll()
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        app.zoomAt(1.2)
      } else if (mod && e.key === '-') {
        e.preventDefault()
        app.zoomAt(1 / 1.2)
      } else if (mod && e.key === '0') {
        e.preventDefault()
        app.fitAll()
      } else if (mod && e.key === '1') {
        e.preventDefault()
        const vp = app.viewport
        const cam = activeWs()!.camera
        app.centerOn((vp.w / 2 - cam.x) / cam.zoom, (vp.h / 2 - cam.y) / cam.zoom, 1)
      } else if (mod && key === 'a') {
        e.preventDefault()
        const ws = activeWs()!
        // not what a folded group hides: a Delete after Ctrl+A should not reach consoles you cannot see
        const folded = hiddenIds(ws)
        app.setSelection(ws.nodes.filter((n) => !folded.has(n.id)).map((n) => n.id))
      } else if (!mod && !e.altKey && key === 'z') {
        setCmd('zoom')
        window.clearTimeout(chordTimer)
        chordTimer = window.setTimeout(endChord, 2500)
      } else if (!mod && !e.altKey && key === 'f' && app.selection.length) {
        const node = activeWs()?.nodes.find((n) => n.id === app.selection[0])
        if (node) app.enterFocus(node.id)
      } else if (!mod && !e.altKey) {
        const map: Record<string, any> = { v: 'select', p: 'pen', e: 'eraser', r: 'shape', t: 'text' }
        if (map[key]) app.setTool(map[key])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus shortcuts work everywhere, even inside a terminal (captured before xterm sees them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return
      const app = useApp.getState()
      const k = e.key.toLowerCase()
      if (k === 'f') {
        const target = app.focusedNode ? null : (document.activeElement?.closest('[data-node-id]') as HTMLElement | null)?.dataset.nodeId ?? app.selection[0]
        if (app.focusedNode) app.exitFocus()
        else if (target) app.enterFocus(target)
      } else if (app.focusedNode && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        app.cycleFocus(e.key === 'ArrowRight' ? 1 : -1)
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  // Keep the focused node filling the board when the window resizes.
  useEffect(() => {
    const app = useApp.getState()
    const node = focusedNode ? activeWs()?.nodes.find((n) => n.id === focusedNode) : null
    if (!node) return
    const r = focusRect(viewport)
    const cam = activeWs()!.camera
    if (cam.zoom === 1 && (Math.abs(cam.x - (r.x - node.x)) > 1 || Math.abs(cam.y - (r.y - node.y)) > 1)) app.setCamera({ zoom: 1, x: r.x - node.x, y: r.y - node.y })
  }, [viewport.w, viewport.h])

  if (!ws) return null
  const cam = ws.camera
  const cad = settingsNav !== 'trackpad'

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1) return
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('world')) return
    const app = useApp.getState()
    if (app.focusedNode) return app.exitFocus()
    stopCameraAnimation()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    if (tool === 'text' && e.button === 0) {
      const p = screenToWorld(e.clientX - ref.current!.getBoundingClientRect().left, e.clientY - ref.current!.getBoundingClientRect().top)
      const id = app.addNode({ type: 'text', x: p.x, y: p.y - 20, w: 320, h: 60, data: { text: '', autoFocus: true } })
      app.setSelection([id])
      app.setTool('select')
      return
    }
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const rect = ref.current!.getBoundingClientRect()

    // Selection window (CAD left-drag, or Shift+drag) and Zoom Window.
    //  left→right = WINDOW: picks what is fully inside;  right→left = CROSSING: picks what it touches.
    if (cad || e.shiftKey || cmdRef.current === 'window') {
      const zoomWindow = cmdRef.current === 'window'
      const additive = e.shiftKey
      const before = app.selection
      let moved = false
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) moved = true
        if (!moved) return
        setMarquee({
          x: Math.min(startX, ev.clientX) - rect.left,
          y: Math.min(startY, ev.clientY) - rect.top,
          w: Math.abs(ev.clientX - startX),
          h: Math.abs(ev.clientY - startY),
          mode: zoomWindow ? 'zoom' : ev.clientX >= startX ? 'window' : 'crossing'
        })
      }
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        setMarquee(null)
        if (!moved) {
          if (!additive && !zoomWindow) app.setSelection([])
          return
        }
        const a = screenToWorld(Math.min(startX, ev.clientX) - rect.left, Math.min(startY, ev.clientY) - rect.top)
        const b = screenToWorld(Math.max(startX, ev.clientX) - rect.left, Math.max(startY, ev.clientY) - rect.top)
        const box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
        if (zoomWindow) {
          setCmd(null)
          app.zoomToRect(box, 10, MAX_ZOOM)
          return
        }
        const crossing = ev.clientX < startX
        const w = activeWs()!
        const pick = (r: { x: number; y: number; w: number; h: number }) => (crossing ? intersects(box, r) : within(box, r))
        const folded = hiddenIds(w)
        const hits = [...w.nodes.filter((n) => !folded.has(n.id)), ...w.ink, ...(crossing ? [] : w.groups.map((g) => ({ ...g, ...groupBox(g) })))].filter(pick).map((n) => n.id)
        app.setSelection(additive ? [...new Set([...before, ...hits])] : hits)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      return
    }

    // trackpad navigation: left drag on empty board pans
    app.setSelection([])
    setPanning(true)
    const start = { ...cam }
    const move = (ev: PointerEvent) => app.setCamera({ x: start.x + ev.clientX - startX, y: start.y + ev.clientY - startY })
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setPanning(false)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const app = useApp.getState()
    const rect = ref.current!.getBoundingClientRect()
    const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    const files = [...e.dataTransfer.files]
    let offset = 0
    for (const f of files) {
      const path = window.fb.pathForFile(f).replace(/\\/g, '/')
      if (f.type.startsWith('image/')) {
        const img = await loadImageSize(path)
        const scale = Math.min(1, 640 / img.w)
        app.addNode({ type: 'image', x: p.x + offset, y: p.y + offset, w: img.w * scale, h: img.h * scale, data: { path } })
      } else {
        const stat = await request('fs:stat', path)
        if (stat && !stat.dir) app.addNode({ type: 'file', x: p.x + offset, y: p.y + offset, data: { path } })
      }
      offset += 30
    }
    if (!files.length && /^https?:\/\//.test(url)) app.addNode({ type: 'web', x: p.x, y: p.y, w: 720, h: 480, data: { url: url.trim() } })
  }

  const hidden = hiddenIds(ws)
  const bounds = selectionBox(ws, selection)
  return (
    <div
      ref={ref}
      className={`board tool-${tool} ${panning ? 'panning' : ''} ${cmd === 'window' ? 'zoom-window' : ''} ${focusedNode ? 'focus-mode' : ''} ${compact && !focusedNode ? 'zoom-compact' : ''}`}
      style={{
        backgroundSize: `${22 * cam.zoom}px ${22 * cam.zoom}px`,
        backgroundPosition: `${cam.x}px ${cam.y}px`
      }}
      onPointerDown={onPointerDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
        {ws.groups.map((g) => (
          <GroupFrame key={g.id} group={g} selected={selection.includes(g.id)} />
        ))}
        <Wires nodes={ws.nodes} groups={ws.groups} wires={ws.wires} />
        <WirePreview ws={ws} boardRef={ref} />
        {ws.nodes.map((n) =>
          n.id === focusedNode ? (
            <NodeFrame key={n.id} node={n} selected={false} zoom={1} maximized />
          ) : (
            <NodeFrame key={n.id} node={n} selected={selection.includes(n.id)} zoom={cam.zoom} offscreen={offscreen(n, cam, viewport)} hidden={hidden.has(n.id)} />
          )
        )}
        {bounds && <div className="sel-bounds" aria-hidden="true" style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }} />}
      </div>
      <InkLayer ws={ws} />
      {marquee && <div className={`marquee ${marquee.mode}`} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      {cmd && (
        <div className="cad-cmd">
          {cmd === 'zoom' ? (
            <>
              <b>ZOOM</b> <span>[<u>E</u>]xtents</span> <span>[<u>P</u>]revious</span> <span>[<u>W</u>]indow</span> <span>[<u>O</u>]bject</span>
            </>
          ) : (
            <>
              <b>ZOOM WINDOW</b> <span>drag a window to zoom into · Esc to cancel</span>
            </>
          )}
        </div>
      )}
      {!ws.nodes.length && !ws.groups.length && !ws.ink.length && <EmptyBoard />}
    </div>
  )
}

function loadImageSize(path: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 480, h: 320 })
    img.src = fileUrl(path)
  })
}

/**
 * An empty board offers a first goal taken from the repo (goalIdeas.ts): one click puts it in the
 * command bar, where Enter starts a team on it. Building a board by hand is still there, second.
 */
function EmptyBoard() {
  const app = useApp.getState()
  const ideas = useGoalIdeas()
  return (
    <div className="empty-board">
      <div className="empty-title">
        An empty board. <em>Give it a goal.</em>
      </div>
      {ideas.length > 0 && (
        <div className="eb-ideas">
          {ideas.map((g) => (
            <button key={g.text} className="eb-idea" onClick={() => offerGoal(g.text)}>
              <span className="eb-idea-text">{g.text}</span>
              <span className="eb-idea-why">{g.why}</span>
            </button>
          ))}
          <div className="dim eb-note">Pick one to put it in the bar, or type your own. A Lead plans it and workers build it in their own branches.</div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
        <button className={`btn ${ideas.length ? '' : 'primary'}`} onClick={() => app.openPanel('composer')}>
          Compose a team
        </button>
        <button className="btn" onClick={() => app.openPanel('presets')}>
          Presets
        </button>
        <button className="btn" onClick={() => app.openPanel('spawn')}>
          New console
        </button>
      </div>
      <div className="dim" style={{ marginTop: 14, fontSize: 12 }}>
        Scroll to zoom · Middle-drag to pan · Double-middle-click to fit · Hold <span className="kbd">Space</span> to speak
      </div>
    </div>
  )
}
