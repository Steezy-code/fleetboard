// Terminal output to plain text, for matching words in a stream (loop triggers, headless CLI output).
// For what a console shows right now, main keeps a real screen model (src/main/screen.ts).

// OSC/DCS strings end at the first BEL or ESC\ (non-greedy: shells emit many, e.g. OSC 3008 per command)
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b[()][0-9A-B]|\x1b[=>78DEHMc]/g
// TUIs often draw spaces as cursor-forward moves and lines as absolute positioning.
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(200, Number(n || 1))))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(ANSI, '')
    .replace(/\r/g, '')
