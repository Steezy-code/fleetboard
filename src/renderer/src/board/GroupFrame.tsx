import { memo, useState } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type { Group } from '@shared/types'
import { ROLES, ROLE_TINT } from '@shared/types'
import { activeWs, connectClick, useApp } from '../state/store'
import { killConsoles, pauseAll, resumeAll } from '../engine/consoles'
import { snap } from './geometry'
import { GAP, GROUP_HEAD_H, findFreeSpot, occupied } from './place'

/**
 * Fold a group down to its header, or open it again. Folded, its consoles keep running at their size
 * (NodeFrame hides them without unmounting, so no terminal is resized to nothing) and the header still
 * counts who is working and who needs you. Opened, if whatever took its space meanwhile would now be
 * covered, the whole group moves to the nearest free spot instead of landing on top of it.
 */
export function toggleCollapsed(id: string) {
  const app = useApp.getState()
  const ws = activeWs()
  const g = ws?.groups.find((x) => x.id === id)
  if (!ws || !g) return
  const members = ws.nodes.filter((n) => n.groupId === id).map((n) => n.id)
  if (!g.collapsed) {
    if (app.focusedNode && members.includes(app.focusedNode)) app.exitFocus()
    app.setSelection(app.selection.filter((sid) => !members.includes(sid)))
    return app.updateGroup(id, { collapsed: true })
  }
  const own = new Set([id, ...members])
  const others = occupied({ ...ws, nodes: ws.nodes.filter((n) => !own.has(n.id)), groups: ws.groups.filter((x) => x.id !== id) })
  const full = { w: g.w, h: g.h }
  const clear = findFreeSpot(others, full, { x: g.x, y: g.y }, 0)
  const spot = clear.x === Math.round(g.x) && clear.y === Math.round(g.y) ? null : findFreeSpot(others, full, { x: g.x, y: g.y }, GAP)
  app.updateGroup(id, { collapsed: false })
  if (spot) app.moveNodes([id, ...members], spot.x - g.x, spot.y - g.y)
}

function startGroupDrag(e: React.PointerEvent, g: Group) {
  if (e.button !== 0) return
  e.stopPropagation()
  const app = useApp.getState()
  if (app.tool === 'connector') return connectClick(g.id)
  app.setSelection([g.id])
  const ws = activeWs()!
  const zoom = ws.camera.zoom
  const ids = [g.id, ...ws.nodes.filter((n) => n.groupId === g.id).map((n) => n.id)]
  let lx = e.clientX
  let ly = e.clientY
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    useApp.getState().moveNodes(ids, (ev.clientX - lx) / zoom, (ev.clientY - ly) / zoom)
    lx = ev.clientX
    ly = ev.clientY
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    const cur = activeWs()!.groups.find((x) => x.id === g.id)
    if (cur) {
      const dx = snap(cur.x) - cur.x
      const dy = snap(cur.y) - cur.y
      useApp.getState().moveNodes(ids, dx, dy)
    }
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

export const GroupFrame = memo(function GroupFrame({ group, selected }: { group: Group; selected: boolean }) {
  const tint = ROLE_TINT[group.role]
  const memberIds = useApp((s) => {
    const p = s.project
    const ws = p?.workspaces.find((w) => w.id === p.activeWorkspaceId)
    return ws?.nodes.filter((n) => n.groupId === group.id && n.type === 'console').map((n) => n.id).join(',') ?? ''
  })
  const ids = memberIds ? memberIds.split(',') : []
  const working = useApp((s) => ids.filter((id) => s.statuses[id] === 'working').length)
  const needs = useApp((s) => ids.filter((id) => s.statuses[id] === 'needs-you').length)
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const app = useApp.getState()
  const summary = needs ? `${needs} need you` : working ? `${working} running` : ids.length ? 'idle' : 'empty'

  return (
    <div
      className={`group ${selected ? 'selected' : ''} ${group.collapsed ? 'collapsed' : ''}`}
      style={{ left: group.x, top: group.y, width: group.w, height: group.collapsed ? Math.min(group.h, GROUP_HEAD_H) : group.h, ['--tint' as any]: tint }}
      data-group-id={group.id}
    >
      <div className="group-head" onPointerDown={(e) => startGroupDrag(e, group)} onDoubleClick={() => setEditing(true)}>
        <span className="dot" style={{ background: tint }} />
        {editing ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={group.name}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              app.updateGroup(group.id, { name: e.target.value.trim() || group.name })
              setEditing(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="group-name">{group.name}</span>
        )}
        <span className="group-count">{ids.length}</span>
        <span className="group-sum">· {summary}</span>
        <button
          className="icon-btn sm"
          title={group.collapsed ? 'Open the group' : 'Fold the group to its header (its consoles keep running)'}
          aria-expanded={!group.collapsed}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleCollapsed(group.id)}
        >
          {group.collapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
        <button className="icon-btn sm" onPointerDown={(e) => e.stopPropagation()} onClick={() => setMenu(!menu)}>
          <ChevronDown size={13} />
        </button>
        {menu && (
          <div className="menu" style={{ top: 30, left: 0 }} onPointerDown={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
            <div className="menu-label label">Role</div>
            <div className="role-grid">
              {ROLES.map((r) => (
                <button
                  key={r}
                  className={`chip ${group.role === r ? 'on' : ''}`}
                  style={{ height: 24 }}
                  onClick={() => app.updateGroup(group.id, { role: r })}
                >
                  <span className="dot" style={{ background: ROLE_TINT[r] }} />
                  {r}
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (setEditing(true), setMenu(false))}>
              Rename
            </button>
            <button className="menu-item" onClick={() => (toggleCollapsed(group.id), setMenu(false))}>
              {group.collapsed ? 'Open' : 'Fold to header'}
            </button>
            {!group.collapsed && (
              <button className="menu-item" onClick={() => (app.fitGroup(group.id), setMenu(false))}>
                Fit to members
              </button>
            )}
            <button className="menu-item" onClick={() => (pauseAll(ids), setMenu(false))}>
              Pause team
            </button>
            <button className="menu-item" onClick={() => (resumeAll(ids), setMenu(false))}>
              Resume team
            </button>
            <button className="menu-item" onClick={() => (app.openPanel('handoff', { from: ids }), setMenu(false))}>
              Hand off team task…
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (app.removeGroup(group.id), setMenu(false))}>
              Ungroup
            </button>
            <button
              className="menu-item"
              style={{ color: 'var(--danger)' }}
              onClick={async () => {
                setMenu(false)
                if (await killConsoles(ids, { remove: true })) app.removeGroup(group.id, true)
              }}
            >
              Close team
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
