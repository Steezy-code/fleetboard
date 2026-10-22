import { Ban, CircleHelp, TerminalSquare } from 'lucide-react'
import type { Ambiguity, Charter } from '@shared/charter'
import { fullCard } from './inboxModel'

// The charter on the command bar, in the two renderings the design asks for: the full card where it
// is unsure and has something to show for it, one line to glance at otherwise. Its answers are the
// Inbox card's own buttons (InboxTray.tsx), as an approval's options are.

/**
 * What kind of gap the one question is about. A named gap is something to act on where a bare score
 * is not, which is why the charter carries one instead of a number.
 */
const GAP: Record<Ambiguity, string> = {
  scope: 'Unclear how much',
  acceptance: 'Unclear when it is done',
  subject: 'Unclear which thing',
  constraint: 'A limit it did not state'
}

/**
 * The check that proves the job finished. On screen in both renderings: the model wrote it, and a
 * later phase runs it on a loop, so it is never agreed to unseen.
 */
const Check = ({ cmd }: { cmd: string }) => (
  <span className="ch-done">
    <TerminalSquare size={12} />
    <span>{cmd}</span>
  </span>
)

export function CharterCard({ charter: c }: { charter: Charter }) {
  // the line truncates and the command does not: between the two, the command is the one that runs
  if (!fullCard(c))
    return (
      <div className="ch-one">
        <span className="ch-understood">{c.understood}</span>
        {c.doneWhen && <Check cmd={c.doneWhen} />}
      </div>
    )

  return (
    <>
      <div className="it-q">{c.understood}</div>
      {c.assumptions.length > 0 && (
        <div className="ch-rows">
          {c.assumptions.map((a, i) => (
            <div key={i} className="ch-row">
              <span className={`ch-badge ${a.known ? 'known' : 'guess'}`}>{a.known ? 'known' : 'guess'}</span>
              <span className="ch-text">{a.text}</span>
              {a.from && <span className="ch-from">{a.from}</span>}
            </div>
          ))}
        </div>
      )}
      {c.wontTouch.length > 0 && (
        <div className="ch-row">
          <Ban size={12} />
          <span className="ch-label">Won’t touch</span>
          <span className="ch-text ch-paths">{c.wontTouch.join(' · ')}</span>
        </div>
      )}
      {c.doneWhen && (
        <div className="ch-row">
          <span className="ch-label">Done when</span>
          <Check cmd={c.doneWhen} />
        </div>
      )}
      {c.question && (
        <div className="ch-ask">
          <div className="ch-gap">
            <CircleHelp size={12} /> {c.ambiguity ? GAP[c.ambiguity] : 'One thing to settle'}
          </div>
          <div className="it-q">{c.question.text}</div>
        </div>
      )}
    </>
  )
}
