import { useEffect, useState } from 'react'
import type { BoardPreview, SnapshotInfo } from '@shared/recovery'
import { errorText, request } from '../lib/api'
import { useApp } from '../state/store'

export function RecoverySection() {
  const projectId = useApp((s) => s.project?.id)
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [preview, setPreview] = useState<BoardPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (projectId) request('recovery:list').then(setSnapshots, (e) => setError(errorText(e))) }, [projectId])
  if (!projectId) return <p className="muted small">Open a board to export it, import a board, or restore a snapshot.</p>
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const apply = () => run(async () => {
    if (!preview) return
    const ok = await useApp.getState().confirm({ title: 'Replace this board?', body: 'Your current board is saved as a snapshot first. Close running consoles and finish or discard the current team before continuing. Repository files are unchanged.', confirm: 'Replace board', danger: true })
    if (ok) await useApp.getState().recoverBoard(preview.token)
  })
  return <div className="settings-rows" style={{ padding: 14 }}>
    <div className="row" style={{ gap: 8 }}>
      <button className="btn sm" disabled={busy} onClick={() => run(async () => { const board = useApp.getState().project; if (!board) return; await request('store:saveProject', board); const file = await request('recovery:export'); if (file) useApp.getState().toast(`Board exported to ${file}`, 'ok') })}>Export board</button>
      <button className="btn sm" disabled={busy} onClick={() => run(async () => setPreview(await request('recovery:import')))}>Import board…</button>
      <button className="btn sm" disabled={busy} onClick={() => run(async () => setSnapshots(await request('recovery:list')))}>Refresh snapshots</button>
    </div>
    <label className="label" htmlFor="board-snapshot" style={{ display: 'block', marginTop: 12 }}>Restore a snapshot</label>
    <select id="board-snapshot" className="input" disabled={busy} value="" onChange={(e) => { const id = e.target.value; if (id) void run(async () => setPreview(await request('recovery:preview', id))) }}>
      <option value="">{snapshots.length ? 'Select a snapshot to preview…' : 'No snapshots yet'}</option>
      {snapshots.map((s) => <option key={s.id} value={s.id}>{new Date(s.at).toLocaleString()} · {Math.ceil(s.bytes / 1024)} KB</option>)}
    </select>
    {preview && <div style={{ marginTop: 12 }}><b>Preview: {preview.workspaces} workspaces · {preview.tiles} tiles · {preview.consoles} consoles</b><ul>{preview.contents.map((w, i) => <li key={i}><b>{w.name}</b> ({w.tiles} tiles): {w.titles.join(" · ")}</li>)}</ul><ul>{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul><button className="btn danger sm" disabled={busy} onClick={apply}>Replace with this board…</button><button className="btn ghost sm" onClick={() => setPreview(null)}>Cancel preview</button></div>}
    {error && <p role="alert">{error}</p>}
  </div>
}
