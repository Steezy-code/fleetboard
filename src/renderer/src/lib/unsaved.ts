import { useApp } from '../state/store'

// Editors with unsaved work say so here (the Code studio, the Skills editor), so whatever would take
// the window or the editor away first asks. Quitting only ever saved the board: edits in an editor
// were dropped without a word when the window closed.

const open = new Map<string, string>()

/** `label` names what is unsaved ("parser.ts"); null when it is saved again or the editor closes. */
export function setUnsaved(key: string, label: string | null) {
  if (label) open.set(key, label)
  else open.delete(key)
}

/**
 * Before something that would drop unsaved edits: true when there are none, or the user lets them
 * go. `doing` completes the question, as in "Quit without saving a.ts?".
 */
export async function mayDropUnsaved(doing: string): Promise<boolean> {
  const labels = [...open.values()]
  if (!labels.length) return true
  const names = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  return useApp.getState().confirm({ title: `${doing} without saving ${names}?`, body: 'Your edits have not been saved.', confirm: 'Discard', danger: true })
}
