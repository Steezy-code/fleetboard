import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { invoke } from '../lib/api'
import { useApp } from '../state/store'

// The Inbox itself lives on the command bar now (InboxTray.tsx, inboxModel.ts).

/** Diff of the team's branch, for the Ready card. */
export function FleetDiffPanel({ projectId }: { projectId: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  useEffect(() => {
    invoke<string>('fleet:diff', projectId).then(setDiff)
  }, [projectId])
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && useApp.getState().closePanel()}>
      <div className="modal" style={{ width: 'min(1100px, 94vw)', height: '84vh' }}>
        <div className="modal-head">
          <div className="grow">
            <div className="modal-title">Team changes</div>
            <div className="modal-sub">Everything the team will merge into your branch.</div>
          </div>
          <button className="icon-btn" onClick={() => useApp.getState().closePanel()}>
            <X size={16} />
          </button>
        </div>
        <pre className="fleet-diff scrollable">
          {diff === null
            ? 'Loading…'
            : diff.split('\n').map((l, i) => (
                <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'file' : ''}>
                  {l + '\n'}
                </span>
              ))}
        </pre>
      </div>
    </div>
  )
}
