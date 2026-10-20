// App themes: the CSS color tokens (applied to :root by the renderer) and each theme's terminal
// palette. Ember is the original look and also what theme.css's :root holds, so the window looks
// right before any script runs.

export interface TermPalette {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: string
  name: string
  blurb: string
  light: boolean
  /** CSS custom properties without the leading -- */
  tokens: Record<string, string>
  term: Omit<TermPalette, 'cursor' | 'selectionBackground'>
}

const DARK_TERM = {
  black: '#1c1917',
  red: '#ff5f4a',
  green: '#4ade80',
  yellow: '#f5c06b',
  blue: '#7aa2ff',
  magenta: '#d68cff',
  cyan: '#5fd7d7',
  white: '#d6cfc7',
  brightBlack: '#5f5750',
  brightRed: '#ff7a63',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#a5c0ff',
  brightMagenta: '#e9b5ff',
  brightCyan: '#99f6e4',
  brightWhite: '#fafaf9'
}

/**
 * Every theme, first one first. Typed as a list that is never empty, because themeById falls back to
 * THEMES[0] for an unknown id and the whole app's colours come from what it returns.
 */
export const THEMES: readonly [Theme, ...Theme[]] = [
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'Warm near-black, orange-red. The original.',
    light: false,
    tokens: {
      bg: '#0b0a09',
      board: '#100e0d',
      dot: 'rgba(255, 240, 225, 0.07)',
      panel: '#161412',
      'panel-2': '#1c1917',
      'panel-3': '#23201d',
      line: '#2a2622',
      'line-2': '#3a342f',
      'line-3': '#4a433d',
      text: '#ede7e0',
      'text-2': '#c9c0b6',
      muted: '#8f857b',
      dim: '#5f5750',
      accent: '#ff4a2b',
      ok: '#3ecf8e',
      warn: '#f5b740',
      danger: '#f43f5e',
      blue: '#6b7cff',
      info: '#60a5fa'
    },
    term: { background: '#0c0b0a', foreground: '#e9e2da', ...DARK_TERM }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    blurb: 'Cool blue-gray, electric blue.',
    light: false,
    tokens: {
      bg: '#0a0c11',
      board: '#0d1016',
      dot: 'rgba(200, 215, 255, 0.07)',
      panel: '#131720',
      'panel-2': '#191e29',
      'panel-3': '#202633',
      line: '#262d3b',
      'line-2': '#343d4f',
      'line-3': '#465064',
      text: '#e6e9f0',
      'text-2': '#b9c0cf',
      muted: '#7f899c',
      dim: '#586174',
      accent: '#4c8dff',
      ok: '#3ecf8e',
      warn: '#f5b740',
      danger: '#f43f5e',
      blue: '#9b7cff',
      info: '#38bdf8'
    },
    term: { ...DARK_TERM, background: '#0b0e14', foreground: '#dfe5f0', black: '#1a1f2a', brightBlack: '#586174', white: '#c9d1e0', brightWhite: '#f5f7fb' }
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    blurb: 'Deep violet night, hot pink and neon cyan.',
    light: false,
    tokens: {
      bg: '#0c0716',
      board: '#100a1d',
      dot: 'rgba(255, 120, 240, 0.08)',
      panel: '#160e27',
      'panel-2': '#1d1332',
      'panel-3': '#25193f',
      line: '#2d1f4a',
      'line-2': '#3e2b62',
      'line-3': '#553a80',
      text: '#f4eaff',
      'text-2': '#cdb9ec',
      muted: '#9580b8',
      dim: '#6a5790',
      accent: '#ff2fb3',
      ok: '#2de2c9',
      warn: '#ffd23f',
      danger: '#ff4d6d',
      blue: '#7a5cff',
      info: '#3ad6ff'
    },
    term: {
      background: '#0e0819',
      foreground: '#f0e4ff',
      black: '#1d1332',
      red: '#ff4d6d',
      green: '#2de2c9',
      yellow: '#ffd23f',
      blue: '#7a8cff',
      magenta: '#ff5ec8',
      cyan: '#3ad6ff',
      white: '#d9c8f2',
      brightBlack: '#6a5790',
      brightRed: '#ff7a92',
      brightGreen: '#7cf5e3',
      brightYellow: '#ffe580',
      brightBlue: '#a9b4ff',
      brightMagenta: '#ff9ade',
      brightCyan: '#8ce8ff',
      brightWhite: '#fbf6ff'
    }
  },
  {
    id: 'forest',
    name: 'Forest',
    blurb: 'Deep pine green, warm amber.',
    light: false,
    tokens: {
      bg: '#080c0a',
      board: '#0b110e',
      dot: 'rgba(210, 240, 220, 0.07)',
      panel: '#111915',
      'panel-2': '#16201b',
      'panel-3': '#1c2822',
      line: '#233029',
      'line-2': '#304137',
      'line-3': '#415648',
      text: '#e6efe9',
      'text-2': '#bfd0c5',
      muted: '#84998b',
      dim: '#5b6e62',
      accent: '#e8a93a',
      ok: '#5fd38d',
      warn: '#e8c547',
      danger: '#ef5b5b',
      blue: '#6fa8dc',
      info: '#5cc8d6'
    },
    term: { ...DARK_TERM, background: '#0a0f0c', foreground: '#dfeae2', black: '#16201b', brightBlack: '#5b6e62', yellow: '#e8c547', white: '#c9d6cd' }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Neutral grays, acid lime. High contrast.',
    light: false,
    tokens: {
      bg: '#0a0a0a',
      board: '#0e0e0e',
      dot: 'rgba(255, 255, 255, 0.07)',
      panel: '#151515',
      'panel-2': '#1b1b1b',
      'panel-3': '#222222',
      line: '#2a2a2a',
      'line-2': '#383838',
      'line-3': '#4a4a4a',
      text: '#ededed',
      'text-2': '#c4c4c4',
      muted: '#8a8a8a',
      dim: '#5c5c5c',
      accent: '#c6f432',
      ok: '#4ade80',
      warn: '#facc15',
      danger: '#f43f5e',
      blue: '#60a5fa',
      info: '#22d3ee'
    },
    term: { ...DARK_TERM, background: '#0c0c0c', foreground: '#e6e6e6', black: '#1b1b1b', brightBlack: '#5c5c5c', white: '#cfcfcf', brightWhite: '#ffffff' }
  },
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Light and warm, for daytime.',
    light: true,
    tokens: {
      bg: '#efebe5',
      board: '#f5f2ed',
      dot: 'rgba(70, 50, 30, 0.13)',
      panel: '#ffffff',
      'panel-2': '#f6f3ee',
      'panel-3': '#ece7e0',
      line: '#e2dcd3',
      'line-2': '#d2c9bd',
      'line-3': '#b9ae9f',
      text: '#1d1a16',
      'text-2': '#3f3a34',
      muted: '#756c62',
      dim: '#9e9488',
      accent: '#e2461d',
      ok: '#15a061',
      warn: '#c98a0b',
      danger: '#e11d48',
      blue: '#4f5fe0',
      info: '#2563eb',
      shadow: '0 18px 50px rgba(60, 40, 20, 0.16), 0 2px 8px rgba(60, 40, 20, 0.08)'
    },
    term: {
      background: '#fbf9f6',
      foreground: '#2a2520',
      black: '#2a2520',
      red: '#c8321b',
      green: '#1a8a4c',
      yellow: '#9a6a00',
      blue: '#2f55c8',
      magenta: '#9b3fbf',
      cyan: '#0f7f8a',
      white: '#8c8278',
      brightBlack: '#6b625a',
      brightRed: '#e2461d',
      brightGreen: '#22a35d',
      brightYellow: '#b98200',
      brightBlue: '#4f6fe0',
      brightMagenta: '#b55ad6',
      brightCyan: '#1597a3',
      brightWhite: '#3f3a34'
    }
  }
]

export const DEFAULT_THEME = 'ember'

export const themeById = (id: string | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0]

const rgbOf = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Dark text on bright accents (lime, amber), white on the rest. */
export function onColor(hex: string): string {
  const rgb = rgbOf(hex)
  if (!rgb) return '#fff'
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return L > 0.42 ? '#141414' : '#fff'
}

export const isHexColor = (s: unknown): s is string => typeof s === 'string' && !!rgbOf(s)

/**
 * Every token for a theme (with an optional accent of the user's), including the ones derived from
 * the accent and status colors: lighter text versions on dark themes, darker ones on light.
 */
export function themeTokens(t: Theme, accentOverride?: string): Record<string, string> {
  const accent = isHexColor(accentOverride) ? accentOverride : t.tokens.accent
  const lift = (v: string, pct: number) => (t.light ? `color-mix(in srgb, var(--${v}) ${100 - pct}%, #000)` : `color-mix(in srgb, var(--${v}) ${100 - pct}%, #fff)`)
  return {
    shadow: '0 18px 50px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4)',
    ...t.tokens,
    accent,
    'accent-2': t.light ? 'color-mix(in srgb, var(--accent) 88%, #fff)' : 'color-mix(in srgb, var(--accent) 82%, #fff)',
    'accent-strong': 'color-mix(in srgb, var(--accent) 76%, #000)',
    'accent-soft': 'color-mix(in srgb, var(--accent) 14%, transparent)',
    'accent-line': 'color-mix(in srgb, var(--accent) 55%, transparent)',
    'accent-text': lift('accent', t.light ? 25 : 55),
    'on-accent': onColor(accent),
    'ok-text': lift('ok', t.light ? 30 : 40),
    'warn-text': lift('warn', t.light ? 35 : 40),
    'danger-strong': 'color-mix(in srgb, var(--danger) 80%, #000)',
    'danger-text': lift('danger', t.light ? 20 : 45),
    'blue-text': lift('blue', t.light ? 20 : 40),
    'info-text': lift('info', t.light ? 20 : 40)
  }
}

export function terminalTheme(t: Theme, accentOverride?: string): TermPalette {
  const accent = isHexColor(accentOverride) ? accentOverride : t.tokens.accent
  const rgb = rgbOf(accent) ?? [255, 74, 43]
  return { ...t.term, cursor: accent, selectionBackground: `rgba(${rgb.join(',')},${t.light ? 0.22 : 0.3})` }
}
