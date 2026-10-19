import { useEffect, useRef } from 'react'
import { Keyboard, Mic, Trash2 } from 'lucide-react'
import { Drawer } from '../ui/Modal'
import { hydrateThread, useThread, type ThreadEntry } from '../voice/thread'
import { CommandInput } from '../voice/CommandBar'

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = (at: number) => new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

/** Thread drawer: every command, plan and reply, with an input that works like the command bar. */
export default function ChatPanel(_props: Record<string, any>) {
  const entries = useThread((s) => s.entries)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => hydrateThread(), [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [entries.length])

  return (
    <Drawer
      title="Thread"
      icon={<span className="orb sm" />}
      width={400}
      headerRight={
        entries.length > 0 && (
          <button className="icon-btn sm" title="Clear thread" onClick={() => useThread.getState().clear()}>
            <Trash2 size={13} />
          </button>
        )
      }
    >
      <div className="thread">
        <div className="thread-list">
          {!entries.length && (
            <div className="empty">
              Talk to the whole board.
              <span className="dim" style={{ fontSize: 12 }}>
                Try “spawn 3 codex”, “group them as reviewers”, “tell everyone to run the tests”.
              </span>
            </div>
          )}
          {entries.map((e, i) => (
            <Entry key={e.id} e={e} prev={entries[i - 1]} />
          ))}
          <div ref={end} />
        </div>
        <div className="thread-input">
          <div className="ti-box">
            <CommandInput placeholder="Message the board · @ to direct…" autoFocus />
          </div>
        </div>
      </div>
    </Drawer>
  )
}

function Entry({ e, prev }: { e: ThreadEntry; prev?: ThreadEntry }) {
  const newDay = !prev || day(prev.at) !== day(e.at)
  return (
    <>
      {newDay && <div className="thread-day">{day(e.at)}</div>}
      {e.kind === 'user' ? (
        <div className="th-user" title={time(e.at)}>
          <span className="th-src">{e.source === 'voice' ? <Mic size={11} /> : <Keyboard size={11} />}</span>
          {e.text}
        </div>
      ) : (
        <div className={`th-sys ${e.kind}`} title={time(e.at)}>
          <span className={`orb sm`} />
          <span className="th-text">{e.kind === 'plan' ? <PlanText text={e.text} /> : e.text}</span>
        </div>
      )}
    </>
  )
}

function PlanText({ text }: { text: string }) {
  const m = /^Plan · ([\s\S]*)$/.exec(text)
  if (!m) return <>{text}</>
  return (
    <>
      <b>Plan</b> · {m[1]}
    </>
  )
}
