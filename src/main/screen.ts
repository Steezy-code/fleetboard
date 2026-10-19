import xterm from '@xterm/xterm'

// What a console's terminal is showing right now. TUIs (Claude Code, Codex, Gemini) draw with
// cursor moves, absolute columns and partial redraws, so the raw output stream is not the screen:
// text they erased is still in it and words are glued together by escape codes. A headless xterm
// (the same emulator the board renders with) replays the output so status detection, the Inbox and
// handoffs read exactly what the user would see.

export interface ScreenView {
  /** visible rows, right-trimmed */
  lines: string[]
  cursorX: number
  cursorY: number
  /** the program switched to the alternate screen (full-screen TUIs, vim, less) */
  alt: boolean
  /** the program hid the cursor (DECTCEM): TUIs drawing their own interface do */
  cursorHidden: boolean
  /** terminal width: a line this long wrapped */
  cols?: number
}

const SCROLLBACK = 2000

export class TermScreen {
  private term: InstanceType<typeof xterm.Terminal>
  private pending = 0
  private cursorHidden = false

  constructor(cols: number, rows: number) {
    this.term = new xterm.Terminal({ cols: Math.max(2, cols | 0), rows: Math.max(1, rows | 0), scrollback: SCROLLBACK, allowProposedApi: true })
    // xterm keeps cursor visibility private; watch DECTCEM (CSI ? 25 h / l) and let xterm handle it too
    const watch = (final: 'h' | 'l') =>
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.some((p) => p === 25)) this.cursorHidden = final === 'l'
        return false
      })
    watch('h')
    watch('l')
    // a full reset (RIS) shows the cursor again
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.cursorHidden = false
      return false
    })
  }

  write(data: string) {
    this.pending++
    this.term.write(data, () => this.pending--)
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve))
  }

  /** Parsing is asynchronous; a view taken while output is queued can lag it by a few ms. */
  get busy() {
    return this.pending > 0
  }

  resize(cols: number, rows: number) {
    const c = cols | 0
    const r = rows | 0
    // a hidden or collapsed node reports 0×0: keep the last real size rather than crush the content
    if (c < 2 || r < 1 || (c === this.term.cols && r === this.term.rows)) return
    this.term.resize(c, r)
  }

  /** the program switched the arrow keys to application mode (DECCKM) */
  get appCursorKeys() {
    return this.term.modes.applicationCursorKeysMode
  }

  get cols() {
    return this.term.cols
  }

  get rows() {
    return this.term.rows
  }

  view(): ScreenView {
    const b = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.baseY + i)?.translateToString(true) ?? '')
    return { lines, cursorX: b.cursorX, cursorY: b.cursorY, alt: b.type === 'alternate', cursorHidden: this.cursorHidden, cols: this.term.cols }
  }

  /**
   * Plain text of the scrollback and screen, newest last, at most `chars` characters. Soft-wrapped
   * rows are joined back into one line, trailing blank rows are dropped.
   */
  text(chars = 12000): string {
    const b = this.term.buffer.active
    const out: string[] = []
    let size = 0
    let row = b.baseY + this.term.rows - 1
    // skip the empty rows under the last line of output
    while (row >= 0 && !(b.getLine(row)?.translateToString(true) ?? '').trim()) row--
    while (row >= 0 && size < chars) {
      // gather one logical line: rows marked isWrapped continue the row above them
      let line = b.getLine(row)?.translateToString(true) ?? ''
      while (row > 0 && b.getLine(row)?.isWrapped) {
        row--
        line = (b.getLine(row)?.translateToString(false) ?? '') + line
      }
      out.push(line)
      size += line.length + 1
      row--
    }
    const text = out.reverse().join('\n')
    return text.length > chars ? text.slice(text.length - chars) : text
  }

  dispose() {
    this.term.dispose()
  }
}
