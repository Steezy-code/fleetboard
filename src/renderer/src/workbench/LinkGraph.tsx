import { useEffect, useMemo, useRef, useState } from 'react'
import { Scan } from 'lucide-react'

export interface GraphNode {
  id: string
  label: string
}

interface Props {
  nodes: GraphNode[]
  edges: [string, string][]
  current?: string | null
  onOpen: (id: string) => void
}

interface Body {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
  ax: number
  ay: number
  deg: number
  fixed: boolean
}

// positions survive re-renders and reopening the graph
const memory = new Map<string, { x: number; y: number }>()

const REPULSE = 2600
const SPRING = 0.045
const REST = 74
const CENTER = 0.012
const DAMP = 0.86
const MAX_V = 40

/** Force-directed note graph on a canvas: drag nodes, pan, wheel-zoom, hover for names, click to open. */
export function LinkGraph({ nodes, edges, current, onOpen }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const sim = useRef({
    bodies: [] as Body[],
    byId: new Map<string, Body>(),
    links: [] as [Body, Body][],
    neighbors: new Map<string, Set<string>>(),
    alpha: 1,
    cam: { x: 0, y: 0, k: 1 },
    hover: null as Body | null,
    drag: null as null | { body: Body | null; sx: number; sy: number; cx: number; cy: number; moved: number },
    w: 0,
    h: 0,
    raf: 0,
    current: current ?? null,
    /** the user moved the camera: stop auto-fitting */
    userCam: false
  })
  const [hoverLabel, setHoverLabel] = useState<{ text: string; x: number; y: number } | null>(null)
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  const linkCount = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id))
    return new Set(edges.filter(([a, b]) => a !== b && ids.has(a) && ids.has(b)).map(([a, b]) => (a < b ? a + '\0' + b : b + '\0' + a))).size
  }, [nodes, edges])

  // (re)build the bodies when the graph changes, keeping known positions
  useEffect(() => {
    const s = sim.current
    const old = s.byId
    s.bodies = nodes.map((n, i) => {
      const prev = old.get(n.id)
      const mem = memory.get(n.id)
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2 * 7.3
      const r = 40 + Math.sqrt(i) * 26
      return {
        id: n.id,
        label: n.label,
        x: prev?.x ?? mem?.x ?? Math.cos(a) * r,
        y: prev?.y ?? mem?.y ?? Math.sin(a) * r,
        vx: 0,
        vy: 0,
        ax: 0,
        ay: 0,
        deg: 0,
        fixed: false
      }
    })
    s.byId = new Map(s.bodies.map((b) => [b.id, b]))
    s.neighbors = new Map(s.bodies.map((b) => [b.id, new Set<string>()]))
    s.links = []
    const seen = new Set<string>()
    for (const [a, b] of edges) {
      const A = s.byId.get(a)
      const B = s.byId.get(b)
      if (!A || !B || A === B) continue
      const key = a < b ? a + '\0' + b : b + '\0' + a
      if (seen.has(key)) continue
      seen.add(key)
      s.links.push([A, B])
      A.deg++
      B.deg++
      s.neighbors.get(a)!.add(b)
      s.neighbors.get(b)!.add(a)
    }
    s.alpha = Math.max(s.alpha, old.size ? 0.5 : 1)
    kick()
  }, [nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    sim.current.current = current ?? null
    kick()
  }, [current]) // eslint-disable-line react-hooks/exhaustive-deps

  function kick() {
    const s = sim.current
    if (!s.raf) s.raf = requestAnimationFrame(frame)
  }

  function computeForces() {
    const s = sim.current
    const B = s.bodies
    for (const b of B) {
      b.ax = -b.x * CENTER
      b.ay = -b.y * CENTER
    }
    // every pair of bodies, which runs every frame: B is dense, so the one check is the flag's price
    B.forEach((a, i) => {
      for (let j = i + 1; j < B.length; j++) {
        const b = B[j]
        if (!b) continue
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.01) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          d2 = 0.5
        }
        if (d2 > 250000) continue
        const d = Math.sqrt(d2)
        const f = REPULSE / d2
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.ax += fx
        a.ay += fy
        b.ax -= fx
        b.ay -= fy
      }
    })
    for (const [a, b] of s.links) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = SPRING * (d - REST)
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.ax += fx
      a.ay += fy
      b.ax -= fx
      b.ay -= fy
    }
  }

  /** One velocity-Verlet step (half-kick, drift, recompute, half-kick) with damping scaled by alpha. */
  function step() {
    const s = sim.current
    const dt = 1
    for (const b of s.bodies) {
      if (b.fixed) continue
      b.vx += 0.5 * b.ax * dt * s.alpha
      b.vy += 0.5 * b.ay * dt * s.alpha
      b.vx = Math.max(-MAX_V, Math.min(MAX_V, b.vx))
      b.vy = Math.max(-MAX_V, Math.min(MAX_V, b.vy))
      b.x += b.vx * dt
      b.y += b.vy * dt
    }
    computeForces()
    for (const b of s.bodies) {
      if (b.fixed) {
        b.vx = b.vy = 0
        continue
      }
      b.vx = (b.vx + 0.5 * b.ax * dt * s.alpha) * DAMP
      b.vy = (b.vy + 0.5 * b.ay * dt * s.alpha) * DAMP
    }
    s.alpha = Math.max(0, s.alpha * 0.985 - 0.0008)
  }

  function fitTarget() {
    const s = sim.current
    if (!s.bodies.length || !s.w) return null
    const xs = s.bodies.map((b) => b.x)
    const ys = s.bodies.map((b) => b.y)
    const l = Math.min(...xs)
    const r = Math.max(...xs)
    const t = Math.min(...ys)
    const b = Math.max(...ys)
    const k = Math.min(1.8, Math.max(0.15, Math.min((s.w - 120) / (r - l || 1), (s.h - 120) / (b - t || 1))))
    return { x: (l + r) / 2, y: (t + b) / 2, k }
  }

  function fit() {
    const t = fitTarget()
    if (t) sim.current.cam = t
  }

  const toScreen = (x: number, y: number) => {
    const s = sim.current
    return { x: s.w / 2 + (x - s.cam.x) * s.cam.k, y: s.h / 2 + (y - s.cam.y) * s.cam.k }
  }
  const toWorld = (x: number, y: number) => {
    const s = sim.current
    return { x: (x - s.w / 2) / s.cam.k + s.cam.x, y: (y - s.h / 2) / s.cam.k + s.cam.y }
  }
  const radius = (b: Body) => 3.2 + Math.sqrt(b.deg) * 1.9

  function frame() {
    const s = sim.current
    s.raf = 0
    const c = canvas.current
    if (!c) return
    const moving = s.alpha > 0.004 || !!s.drag?.body
    if (moving) {
      step()
      step()
    }
    if (!s.userCam) {
      const t = fitTarget()
      if (t) {
        const e = !moving || (s.cam.k === 1 && s.cam.x === 0 && s.cam.y === 0) ? 1 : 0.14
        s.cam = { x: s.cam.x + (t.x - s.cam.x) * e, y: s.cam.y + (t.y - s.cam.y) * e, k: s.cam.k + (t.k - s.cam.k) * e }
      }
    }
    draw(c)
    if (moving) s.raf = requestAnimationFrame(frame)
    else for (const b of s.bodies) memory.set(b.id, { x: b.x, y: b.y })
  }

  function draw(c: HTMLCanvasElement) {
    const s = sim.current
    const ctx = c.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, s.w, s.h)
    const focus = s.drag?.body ?? s.hover
    const near = focus ? s.neighbors.get(focus.id) : null
    const cur = s.current
    const curNear = cur ? s.neighbors.get(cur) : null

    // edges
    ctx.lineWidth = 1
    for (const [a, b] of s.links) {
      const p = toScreen(a.x, a.y)
      const q = toScreen(b.x, b.y)
      const hot = focus && (a === focus || b === focus)
      const curEdge = cur && (a.id === cur || b.id === cur)
      ctx.strokeStyle = hot ? 'rgba(255,107,69,0.85)' : curEdge ? 'rgba(255,74,43,0.42)' : focus ? 'rgba(255,240,225,0.05)' : 'rgba(255,240,225,0.13)'
      ctx.lineWidth = hot ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(q.x, q.y)
      ctx.stroke()
    }

    // nodes
    const k = s.cam.k
    const showAll = k > 1.1 || s.bodies.length <= 24
    ctx.font = `${Math.round(11 * Math.min(1.25, Math.max(0.9, k)))}px "Geist Variable", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const b of s.bodies) {
      const p = toScreen(b.x, b.y)
      if (p.x < -40 || p.y < -40 || p.x > s.w + 40 || p.y > s.h + 40) continue
      const r = radius(b) * Math.max(0.7, Math.min(1.6, k))
      const isCur = b.id === cur
      const isFocus = b === focus
      const isNear = !!near?.has(b.id)
      const dimmed = !!focus && !isFocus && !isNear && !isCur
      let fill = b.deg === 0 ? '#5f5750' : '#a39a90'
      if (curNear?.has(b.id)) fill = '#d8b2a4'
      if (isNear) fill = '#ff8a66'
      if (isFocus) fill = '#ede7e0'
      if (isCur) fill = '#ff4a2b'
      ctx.globalAlpha = dimmed ? 0.3 : 1
      if (isCur) {
        ctx.fillStyle = 'rgba(255,74,43,0.18)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (showAll || isCur || isFocus || isNear) {
        ctx.fillStyle = isCur ? '#ff8a66' : isFocus ? '#ede7e0' : dimmed ? 'rgba(201,192,182,0.4)' : 'rgba(201,192,182,0.85)'
        const label = b.label.length > 28 ? b.label.slice(0, 27) + '…' : b.label
        ctx.fillText(label, p.x, p.y + r + 4)
      }
      ctx.globalAlpha = 1
    }
  }

  // size + dpr
  useEffect(() => {
    const el = wrap.current!
    const c = canvas.current!
    const ro = new ResizeObserver(() => {
      const s = sim.current
      const dpr = window.devicePixelRatio || 1
      s.w = el.clientWidth
      s.h = el.clientHeight
      c.width = Math.round(s.w * dpr)
      c.height = Math.round(s.h * dpr)
      c.style.width = s.w + 'px'
      c.style.height = s.h + 'px'
      draw(c)
      kick()
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      const s = sim.current
      if (s.raf) cancelAnimationFrame(s.raf)
      s.raf = 0
      for (const b of s.bodies) memory.set(b.id, { x: b.x, y: b.y })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // wheel zoom around the cursor (non-passive so the page never scrolls)
  useEffect(() => {
    const c = canvas.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const s = sim.current
      s.userCam = true
      const r = c.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const before = toWorld(mx, my)
      s.cam.k = Math.min(5, Math.max(0.1, s.cam.k * Math.exp(-e.deltaY * 0.0015)))
      const after = toWorld(mx, my)
      s.cam.x += before.x - after.x
      s.cam.y += before.y - after.y
      draw(c)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function hit(mx: number, my: number): Body | null {
    const s = sim.current
    let best: Body | null = null
    let bestD = Infinity
    for (const b of s.bodies) {
      const p = toScreen(b.x, b.y)
      const r = radius(b) * Math.max(0.7, Math.min(1.6, s.cam.k)) + 5
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2
      if (d < r * r && d < bestD) {
        best = b
        bestD = d
      }
    }
    return best
  }

  const local = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const s = sim.current
    const m = local(e)
    const body = hit(m.x, m.y)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    s.drag = { body, sx: m.x, sy: m.y, cx: s.cam.x, cy: s.cam.y, moved: 0 }
    if (body) {
      body.fixed = true
      s.alpha = Math.max(s.alpha, 0.35)
      kick()
    }
  }

  function onMove(e: React.PointerEvent) {
    const s = sim.current
    const m = local(e)
    const c = canvas.current!
    if (s.drag) {
      s.drag.moved += Math.abs(m.x - s.drag.sx) + Math.abs(m.y - s.drag.sy) > 3 ? 1 : 0
      if (s.drag.body) {
        const w = toWorld(m.x, m.y)
        s.drag.body.x = w.x
        s.drag.body.y = w.y
        s.alpha = Math.max(s.alpha, 0.3)
        kick()
      } else {
        s.userCam = true
        s.cam.x = s.drag.cx - (m.x - s.drag.sx) / s.cam.k
        s.cam.y = s.drag.cy - (m.y - s.drag.sy) / s.cam.k
        draw(c)
      }
      return
    }
    const b = hit(m.x, m.y)
    if (b !== s.hover) {
      s.hover = b
      c.style.cursor = b ? 'pointer' : 'grab'
      draw(c)
    }
    setHoverLabel(b ? { text: b.label, x: m.x, y: m.y } : null)
  }

  function onUp() {
    const s = sim.current
    const d = s.drag
    s.drag = null
    if (!d) return
    if (d.body) {
      d.body.fixed = false
      if (d.moved === 0) openRef.current(d.body.id)
      kick()
    }
  }

  return (
    <div className="lgraph" ref={wrap}>
      <canvas
        ref={canvas}
        className="no-board-wheel"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => {
          if (sim.current.drag) return
          sim.current.hover = null
          setHoverLabel(null)
          canvas.current && draw(canvas.current)
        }}
      />
      <div className="lgraph-legend">
        <span>
          {nodes.length} notes · {linkCount} links
        </span>
        <button
          className="icon-btn sm"
          title="Fit graph"
          onClick={() => {
            sim.current.userCam = false
            fit()
            canvas.current && draw(canvas.current)
          }}
        >
          <Scan size={13} />
        </button>
      </div>
      {hoverLabel && (
        <div className="lgraph-tip" style={{ left: hoverLabel.x + 12, top: hoverLabel.y + 12 }}>
          {hoverLabel.text}
        </div>
      )}
    </div>
  )
}
