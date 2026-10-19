import { Pin } from 'lucide-react'
import { Drawer } from '../ui/Modal'
import { useApp } from '../state/store'
import { GitView } from '../workbench/GitView'
import { GithubMark } from '../workbench/icons'

/** Right-side git drawer (opened from the branch badge or the right rail). */
export default function GitPanel(props: { path?: string }) {
  const projectPath = useApp((s) => s.project?.path)
  const cwd = props.path || projectPath
  return (
    <Drawer
      title="Source control"
      icon={<GithubMark size={14} />}
      width={390}
      headerRight={
        cwd ? (
          <button
            className="icon-btn sm"
            title="Pin a git card to the board"
            onClick={() => {
              const app = useApp.getState()
              app.addNode({ type: 'git', data: props.path ? { path: props.path } : {} })
              app.closeDrawer()
            }}
          >
            <Pin size={13} />
          </button>
        ) : undefined
      }
    >
      {cwd ? <GitView cwd={cwd} variant="drawer" /> : <div className="empty">Open a project first</div>}
    </Drawer>
  )
}
