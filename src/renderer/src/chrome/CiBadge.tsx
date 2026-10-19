import { CircleCheck, CircleDashed, CircleX, LoaderCircle, MessageSquareText } from 'lucide-react'
import { useApp } from '../state/store'
import { ciSummary, useCi, useCiWatcher, type CiState } from '../workbench/ciStore'
import { unsent, useFeedback } from '../workbench/prFeedback'

export function CiIcon({ state, size = 13 }: { state: CiState; size?: number }) {
  if (state === 'failing') return <CircleX size={size} className="ci-ic failing" />
  if (state === 'running') return <LoaderCircle size={size} className="ci-ic running" />
  if (state === 'passing') return <CircleCheck size={size} className="ci-ic passing" />
  return <CircleDashed size={size} className="ci-ic none" />
}

const WORD: Record<CiState, string> = { passing: 'passing', failing: 'failing', running: 'running', none: 'no runs' }

/** Bottom-left `◉ CI passing`: the current branch's GitHub Actions, plus red PRs; opens the CI drawer. */
export function CiBadge() {
  useCiWatcher()
  const status = useCi((s) => s.status)
  const open = useApp((s) => s.drawer?.name === 'ci')
  const feedback = useFeedback((s) => s.result)
  useApp((s) => s.project?.extras.prSent) // recount when comments are sent
  const newComments = feedback?.ok ? feedback.prs.reduce((n, p) => n + unsent(p).length, 0) : 0
  if (!status?.ok || (!status.runs.length && !status.prs.length)) return null
  const { state, failingPrs } = ciSummary(status)
  const tip = [
    status.runs.map((r) => `${r.workflow}: ${r.detail.replace(/_/g, ' ')}`).join(' · ') || `No runs on ${status.branch} yet`,
    status.prs.length ? `${status.prs.length} open PR${status.prs.length === 1 ? '' : 's'}${failingPrs ? `, ${failingPrs} failing` : ''}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <button className={`branch-badge ci-badge ${state} ${open ? 'on' : ''}`} title={tip} onClick={() => useApp.getState().openDrawer('ci')}>
      <CiIcon state={state} />
      <span>CI {WORD[state]}</span>
      {failingPrs > 0 && <span className="ci-badge-prs">{failingPrs} PR{failingPrs === 1 ? '' : 's'} red</span>}
      {newComments > 0 && (
        <span className="ci-badge-fb" title={`${newComments} new review comment${newComments === 1 ? '' : 's'}`}>
          <MessageSquareText size={11} /> {newComments}
        </span>
      )}
    </button>
  )
}
