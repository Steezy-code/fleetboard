import { renderMarkdown as render, sanitizeHtml as sanitize } from '../../workbench/markdown'

// Markdown → HTML for the paper preview. The model writes the markdown (and a repo can steer the
// model), so it goes through the app's one allowlist sanitizer before it reaches innerHTML.
//
// This used to call marked.parse directly, which meant a document in this studio got none of what
// workbench/markdown gives the same text in the Markdown vault: relative images never resolved and
// code was never highlighted. It also parsed the sanitizer's output a second time just to mark
// callouts, which is now a step inside the one pass the sanitizer already makes.

/** `className` on a blockquote whose first words are **NOTE**, **TIP**, **WARNING** and so on. */
export const sanitizeHtml = (html: string): string => sanitize(html, { callouts: true })

export const renderMarkdown = (md: string): string => (md ? render(md, { callouts: true }) : '')
