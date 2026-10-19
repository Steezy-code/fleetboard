import { GitBranch } from 'lucide-react'
import { useApp } from '../state/store'
import { useGitStatus } from '../workbench/gitStore'

/** Bottom-left `⎇ main 11`: current branch + changed-file count; opens the git drawer. */
export function BranchBadge() {
  const path = useApp((s) => s.project?.path)
  const open = useApp((s) => s.drawer?.name === 'git')
  const { status } = useGitStatus(path, 4000)
  if (!status) return null
  const n = status.files.length
  const tip = [
    `Branch ${status.branch}`,
    n ? `${n} changed file${n === 1 ? '' : 's'}` : 'Working tree clean',
    status.ahead ? `${status.ahead} to push` : '',
    status.behind ? `${status.behind} to pull` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button className={`branch-badge ${open ? 'on' : ''}`} title={tip} onClick={() => useApp.getState().openDrawer('git')}>
      <GitBranch size={13} />
      <span className="branch-name">{status.branch}</span>
      {n > 0 && <span className="branch-count">{n > 999 ? '999+' : n}</span>}
      {status.ahead > 0 && <span className="branch-ahead">↑{status.ahead}</span>}
    </button>
  )
}
