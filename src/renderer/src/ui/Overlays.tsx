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
          <div key={t.id} className={`toast ${t.tone ?? ''}`}>
            {t.text}
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
                onKeyDown={(e) => e.key === 'Escape' && c.resolve(false)}
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
