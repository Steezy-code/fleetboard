import { forwardRef, useDeferredValue, useMemo, useRef } from 'react'
import { highlightCode } from './markdown'

interface Props {
  value: string
  language: string
  onChange?: (v: string) => void
  onSave?: () => void
  readOnly?: boolean
  className?: string
}

const INDENT = '  '

function lineNumbers(n: number) {
  let s = ''
  for (let i = 1; i <= n; i++) s += i + '\n'
  return s
}

/**
 * Code view with line numbers and syntax highlighting. Editable mode lays a transparent textarea
 * exactly over the highlighted layer (same font metrics, both inside one scroller).
 */
export const CodeEditor = forwardRef<HTMLTextAreaElement, Props>(function CodeEditor({ value, language, onChange, onSave, readOnly, className }, ref) {
  // small files highlight synchronously (no flicker); big ones lag a frame behind typing
  const deferred = useDeferredValue(value)
  const source = value.length < 80_000 ? value : deferred
  const html = useMemo(() => highlightCode(source, language), [source, language])
  const lines = useMemo(() => value.split('\n').length, [value])
  const gutter = useMemo(() => lineNumbers(lines), [lines])
  const localRef = useRef<HTMLTextAreaElement | null>(null)

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave?.()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const { selectionStart: s, selectionEnd: end, value: v } = ta
      if (s === end && !e.shiftKey) {
        document.execCommand('insertText', false, INDENT)
        return
      }
      // indent / outdent the selected lines
      const lineStart = v.lastIndexOf('\n', s - 1) + 1
      const block = v.slice(lineStart, end)
      const next = e.shiftKey ? block.replace(/^( {1,2}|\t)/gm, '') : block.replace(/^/gm, INDENT)
      ta.setSelectionRange(lineStart, end)
      document.execCommand('insertText', false, next)
      ta.setSelectionRange(lineStart, lineStart + next.length)
      return
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      const { selectionStart: s, value: v } = ta
      const lineStart = v.lastIndexOf('\n', s - 1) + 1
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))![0]
      const prev = v[s - 1]
      const extra = prev === '{' || prev === '[' || prev === '(' || prev === ':' ? INDENT : ''
      if (indent || extra) {
        e.preventDefault()
        document.execCommand('insertText', false, '\n' + indent + extra)
      }
    }
  }

  return (
    <div className={`ce scrollable no-board-wheel ${readOnly ? 'readonly' : ''} ${className ?? ''}`}>
      <pre className="ce-gutter" aria-hidden>
        {gutter}
      </pre>
      <div className="ce-code">
        <pre className="ce-hl hljs" aria-hidden={!readOnly}>
          <code dangerouslySetInnerHTML={{ __html: html + '\n' }} />
        </pre>
        {!readOnly && (
          <textarea
            ref={(el) => {
              localRef.current = el
              if (typeof ref === 'function') ref(el)
              else if (ref) ref.current = el
            }}
            className="ce-ta"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
    </div>
  )
})
