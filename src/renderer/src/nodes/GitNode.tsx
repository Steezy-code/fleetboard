import type { NodeProps } from './types'
import { useApp } from '../state/store'
import { GitView } from '../workbench/GitView'

/** Git card on the board: repo, branch, changes, commit & push, recent commits. data.path defaults to the project. */
export default function GitNode({ node }: NodeProps<{ path?: string }>) {
  const projectPath = useApp((s) => s.project?.path)
  const cwd = node.data?.path || projectPath
  if (!cwd) return <div className="empty">No project folder</div>
  return <GitView cwd={cwd} variant="node" />
}
