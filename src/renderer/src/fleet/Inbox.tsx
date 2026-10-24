import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { invoke, errorText } from '../lib/api'
import { useApp } from '../state/store'

// The Inbox itself lives on the command bar now (InboxTray.tsx, inboxModel.ts).

/** Diff of the team's branch, for the Ready card. */
export function FleetDiffPanel({ projectId }: { projectId?: string }) {
  const currentId = useApp((s) => s.project?.id)
  const id = projectId ?? currentId
  const [diff, setDiff] = useState<string | null>(null)
  useEffect(() => {
    if (!id) { setDiff('Open a board to review team changes.'); return }
    let active = true
    setDiff(null)
    invoke<string>('fleet:diff', id).then((text) => { if (active) setDiff(text) }, (e) => { if (active) setDiff(errorText(e)) })
    return () => { active = false }
  }, [id])
  return (
    <Modal title="Team changes" sub="Everything the team will merge into your branch." width="min(1100px, 94vw)" height="84vh" bare>
        <pre className="fleet-diff scrollable">
          {diff === null
            ? 'Loading…'
            : diff.split('\n').map((l, i) => (
                <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'file' : ''}>
                  {l + '\n'}
                </span>
              ))}
        </pre>
    </Modal>
  )
}
