import { useLayoutEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { NodeProps } from './types'
import { fileUrl } from '../lib/api'
import { baseName } from '../workbench/paths'
import { safeUrl } from '../workbench/markdown'
import { useApp } from '../state/store'
import { startNodeDrag } from '../board/NodeFrame'

// A dropped / picked image. Drag it by the picture itself; resizing keeps its aspect ratio.
// Ink can be drawn over it (the ink layer sits above the nodes).
// node.data = { path?: string, src?: string (data/http URL), ratio?: number }

export default function ImageNode({ node, selected }: NodeProps) {
  // node.data.src is persisted in the board file, which an agent can write, and goes straight into
  // <img src>. The same check the markdown sanitizer uses: a local file through fbfile, a raster data
  // URL or http(s) — not file://, not a javascript: URL, and not an SVG data URL, which can script.
  const raw: string | undefined = node.data.src ?? (node.data.path ? fileUrl(node.data.path) : undefined)
  const src = raw ? (safeUrl(raw, 'src') ?? undefined) : undefined
  const ratio: number | undefined = node.data.ratio
  const [failed, setFailed] = useState(false)
  const last = useRef({ w: node.w, h: node.h })

  // keep the aspect ratio: whichever side the user changed drives the other one
  useLayoutEffect(() => {
    const prev = last.current
    last.current = { w: node.w, h: node.h }
    if (!ratio) return
    if (Math.abs(node.w / node.h - ratio) < 0.01) return
    const wChanged = Math.abs(node.w - prev.w) > 0.5
    const hChanged = Math.abs(node.h - prev.h) > 0.5
    const patch = wChanged || !hChanged ? { h: Math.round(node.w / ratio) } : { w: Math.round(node.h * ratio) }
    last.current = { w: patch.w ?? node.w, h: patch.h ?? node.h }
    useApp.getState().updateNode(node.id, patch)
  }, [node.w, node.h, ratio, node.id])

  return (
    <div className={`img-node ${selected ? 'sel' : ''}`} onPointerDown={(e) => startNodeDrag(e, node)}>
      {src && !failed ? (
        <img
          src={src}
          alt={node.data.path ? baseName(node.data.path) : 'image'}
          draggable={false}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const img = e.currentTarget
            const r = img.naturalWidth / (img.naturalHeight || 1)
            if (img.naturalWidth && (!ratio || Math.abs(r - ratio) > 0.001)) useApp.getState().updateNodeData(node.id, { ratio: r })
          }}
        />
      ) : (
        <div className="img-missing">
          <ImageOff size={22} />
          <span>{node.data.path ? baseName(node.data.path) : 'No image'}</span>
          {node.data.path && <span className="dim small">File not found</span>}
        </div>
      )}
    </div>
  )
}
