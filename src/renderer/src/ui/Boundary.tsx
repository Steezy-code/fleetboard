import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** what failed, for the message: "This web tile", "The Loops panel" */
  what: string
  children: ReactNode
  /** a new value (the tile's data, the panel opened again) clears the error and tries again */
  resetKey?: unknown
  actions?: { label: string; run: () => void; danger?: boolean }[]
  compact?: boolean
}
interface State {
  error: Error | null
  key: unknown
}

/**
 * Keeps a crash where it happened. Without it, one tile that cannot render its data (a board saved by
 * another version, an unexpected value) blanks the whole window, and since the board reopens with that
 * tile, it stays blank.
 */
export class Boundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.what} failed to render:`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.compact) return <span className="boundary compact" title={error.message}>{this.props.what} failed</span>
    return (
      <div className="boundary" role="alert" onPointerDown={(e) => e.stopPropagation()}>
        <div className="boundary-title">{this.props.what} could not be shown</div>
        <div className="boundary-detail">{error.message.slice(0, 300)}</div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          {this.props.actions?.map((a) => (
            <button key={a.label} className={`btn sm ${a.danger ? 'danger-text' : ''}`} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
}
