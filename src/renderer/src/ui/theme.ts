import { useEffect } from 'react'
import { terminalTheme, themeById, themeTokens } from '@shared/themes'
import { useApp } from '../state/store'

// Applies the chosen theme (and the user's accent) to :root, and gives terminals their palette.

export function applyTheme(themeId: string, accent?: string) {
  const t = themeById(themeId)
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeTokens(t, accent))) root.style.setProperty(`--${k}`, v)
  root.dataset.theme = t.id
  root.style.colorScheme = t.light ? 'light' : 'dark'
}

export const currentTerminalTheme = () => {
  const s = useApp.getState().settings
  return terminalTheme(themeById(s.theme), s.accent)
}

/** Mounted once in App: follows Settings. */
export function useThemeSync() {
  const theme = useApp((s) => s.settings.theme)
  const accent = useApp((s) => s.settings.accent)
  useEffect(() => {
    applyTheme(theme, accent)
    window.fb.send('app:background', themeById(theme).tokens.bg)
  }, [theme, accent])
}
