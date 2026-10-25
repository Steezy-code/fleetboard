/**
 * One wave per board, then one reveal per tile that arrives later.
 *
 * App.tsx runs the wave when a board comes up and marks that board shown; a tile mounting afterwards
 * decodes itself in (NodeFrame). Keyed by workspace, because a child's effect runs before its
 * parent's: on a board switch the new board's tiles mount first, and they must not mistake the
 * previous board's wave for their own and all animate individually.
 */
let shownWs: string | null = null

export const markBoardRevealed = (ws: string) => {
  shownWs = ws
}

export const boardIsRevealed = (ws: string | undefined) => !!ws && shownWs === ws
