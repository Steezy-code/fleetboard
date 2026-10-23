import { useApp } from '../state/store'

/** Toasts and confirmation dialogs. */
export function Overlays() {
  const toasts = useApp((s) => s.toasts)
  const confirms = useApp((s) => s.confirms)
  const c = confirms[0]
  return (
    <>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? ''} ${t.action ? 'with-action' : ''}`}>
            {t.text}
            {t.action && (
              <button
                className="btn sm"
                onClick={() => {
                  t.action!.run()
                  useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {c && (
        <div className="scrim" style={{ zIndex: 1100 }} onPointerDown={(e) => e.target === e.currentTarget && c.resolve(false)}>
          <div className="modal confirm" style={{ width: 380 }}>
            <div className="modal-head">
              <div className="grow">
                <div className="modal-title">{c.title}</div>
                {c.body && <div className="modal-sub">{c.body}</div>}
              </div>
            </div>
            <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => c.resolve(false)}>
                Cancel
              </button>
              <button
                className={`btn ${c.danger ? 'danger' : 'primary'}`}
                autoFocus
                onClick={() => c.resolve(true)}
                onKeyDown={(e) => {
                  // the dialog's answer, and nothing else's: the board would otherwise also close the panel behind it
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  e.stopPropagation()
                  c.resolve(false)
                }}
              >
                {c.confirm ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
