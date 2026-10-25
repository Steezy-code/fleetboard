/**
 * Whether a key event's target is somewhere the user is typing (a field, an editable region, a
 * terminal, a web tile): board shortcuts and push-to-talk leave the key alone there.
 *
 * One definition. The board and the ink tools matched only contenteditable="true", the voice hotkeys
 * and the Helm card any contenteditable that is not "false" — so a bare `contenteditable` attribute
 * (which means true) was typing for two of them and a shortcut for the others.
 */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [data-terminal], webview'

export const isTypingTarget = (t: EventTarget | null): boolean => !!(t as HTMLElement | null)?.closest?.(TYPING)
