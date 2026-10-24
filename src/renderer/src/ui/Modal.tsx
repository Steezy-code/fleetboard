import { useId, type ReactNode } from 'react'
import { useDialog } from './useDialog'
import { X } from 'lucide-react'
import { useApp } from '../state/store'

interface ModalProps {
  title: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  width?: number | string
  height?: number | string
  onClose?: () => void
  headerRight?: ReactNode
  footer?: ReactNode
  children: ReactNode
  bodyStyle?: React.CSSProperties
  /** no body padding (studios lay out their own panes) */
  bare?: boolean
}

/** Centered modal used by every panel. Contains focus and closes on scrim click or Escape. */
export function Modal({ title, sub, icon, width = 560, height, onClose, headerRight, footer, children, bodyStyle, bare }: ModalProps) {
  const close = onClose ?? useApp.getState().closePanel
  const ref = useDialog(close)
  const titleId = useId()
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="modal" style={{ width, height }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {icon && <div className="modal-icon">{icon}</div>}
          <div className="grow">
            <div id={titleId} className="modal-title">{title}</div>
            {sub && <div className="modal-sub">{sub}</div>}
          </div>
          {headerRight}
          <button className="icon-btn" onClick={close} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className={bare ? 'modal-bare' : 'modal-body scrollable'} style={bodyStyle}>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Floating right-side drawer (usage, accounts, orchestrator, git). */
export function Drawer({ title, icon, headerRight, children, width = 380, onClose }: { title: ReactNode; icon?: ReactNode; headerRight?: ReactNode; children: ReactNode; width?: number; onClose?: () => void }) {
  const close = onClose ?? useApp.getState().closeDrawer
  return (
    <div className="drawer" style={{ width }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="drawer-head">
        {icon}
        <span>{title}</span>
        <span className="spacer" />
        {headerRight}
        <button className="icon-btn sm" aria-label="Close drawer" onClick={close}>
          <X size={14} />
        </button>
      </div>
      <div className="drawer-body scrollable">{children}</div>
    </div>
  )
}

export function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={title ?? "Toggle setting"} title={title} onClick={() => onChange(!on)} />
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
