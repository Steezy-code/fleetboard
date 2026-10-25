/**
 * The launch wave in App.tsx covers every tile that was already on the board. A console that arrives
 * after it decodes itself in instead (NodeFrame), and must not fire while that wave is still running,
 * or the two animations fight over the same tile.
 */
let shown = false

export const markBoardRevealed = () => {
  shown = true
}

export const boardIsRevealed = () => shown
