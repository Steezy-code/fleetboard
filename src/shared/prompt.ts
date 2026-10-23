// A question a console's CLI is waiting on, read from its screen (src/main/status.ts).

export interface PromptOption {
  /** the option's text, wrapped lines joined */
  label: string
  /** a description shown under it, if any */
  detail?: string
  /** the menu's cursor is on it */
  selected: boolean
}

export interface Prompt {
  /** which rule matched, for tests and debugging */
  reason: string
  /**
   * How it is answered: pick an option of a menu, yes or no, Enter to go on, or something only the
   * user can type (a password, an API key, a menu we could not read).
   */
  kind: 'menu' | 'yes-no' | 'enter' | 'input'
  /** the visible lines of the prompt region, box borders removed */
  lines: string[]
  /** the question, when one could be told apart */
  question?: string
  /** a menu's options, top to bottom */
  options?: PromptOption[]
}

/**
 * An answer the main process turns into keystrokes after checking the prompt is still there. `seen`:
 * the card it was given on (approvals.ts seenOf); when set, nothing is typed unless the prompt on
 * screen now still makes that same card, so a stale card never answers a newer question that happens
 * to offer the same button.
 */
export type PromptAnswer = ({ option: string } | { yes: boolean } | { enter: true }) & { seen?: string }

export type AnswerResult = { ok: true } | { ok: false; reason: 'gone' | 'changed' | 'not-live' }

/** What an answer was, in a few words — for the Inbox, a toast, and the journal. */
export const describeAnswer = (a: PromptAnswer): string =>
  'option' in a ? a.option : 'yes' in a ? (a.yes ? 'yes' : 'no') : 'enter'
