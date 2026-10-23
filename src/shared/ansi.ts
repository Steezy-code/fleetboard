// Terminal output to plain text, for matching words in a stream (loop triggers, headless CLI output).
// For what a console shows right now, main keeps a real screen model (src/main/screen.ts).

// OSC/DCS strings end at the first BEL or ESC\, or at the next ESC when one was never terminated.
// Written as "anything but BEL or ESC" rather than a lazy [\s\S]*?: the lazy form scanned to the end
// of the text from every unterminated "ESC ]", which on a CI log of a few hundred kilobytes froze the
// main process for seconds.
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1bP[^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-B]|\x1b[=>78DEHMc]/g
// TUIs often draw spaces as cursor-forward moves and lines as absolute positioning.
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(200, Number(n || 1))))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(ANSI, '')
    .replace(/\r/g, '')
