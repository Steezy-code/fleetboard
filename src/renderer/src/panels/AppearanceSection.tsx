import { Check, RotateCcw } from 'lucide-react'
import { THEMES, isHexColor, onColor, themeById, type Theme } from '@shared/themes'
import { useApp } from '../state/store'

const ACCENTS = ['#ff4a2b', '#e8a93a', '#c6f432', '#3ecf8e', '#2dd4bf', '#4c8dff', '#8b7cff', '#ff2fb3', '#f43f5e']

/** Settings › Appearance: theme cards (a little board + terminal in each theme's colors) and the accent. */
export function AppearanceSection() {
  const theme = useApp((s) => s.settings.theme)
  const accent = useApp((s) => s.settings.accent)
  const motion = useApp((s) => s.settings.motion)
  const set = useApp.getState().setSettings
  const current = themeById(theme)
  const shown = (isHexColor(accent) ? accent : current.tokens.accent).toLowerCase()
  // the theme's own accent first, then the others
  const chips = [current.tokens.accent.toLowerCase(), ...ACCENTS.filter((c) => c !== current.tokens.accent.toLowerCase())]

  return (
    <section data-section="appearance">
      <h3 className="settings-h">Appearance</h3>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <ThemeCard key={t.id} t={t} on={t.id === current.id} accent={isHexColor(accent) ? accent : undefined} onPick={() => set({ theme: t.id })} />
        ))}
      </div>
      <div className="settings-rows" style={{ marginTop: 14 }}>
        <div className="settings-row">
          <label htmlFor="motion-setting">Motion
            <div className="muted small">Subtle keeps effects brief. Full adds brighter traces and arrival rings. System reduced motion always takes priority.</div>
          </label>
          <select id="motion-setting" className="select" style={{ width: 120, flexShrink: 0 }} value={motion} onChange={(e) => set({ motion: e.target.value as 'off' | 'subtle' | 'full' })}>
            <option value="off">Off</option>
            <option value="subtle">Subtle</option>
            <option value="full">Full</option>
          </select>
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div>
            <div>Accent color</div>
            <div className="muted small">Buttons, highlights, the cursor and the voice orb. {isHexColor(accent) ? 'Your own color, kept when you switch themes.' : `${current.name}'s own (first); pick another to use it on any theme.`}</div>
          </div>
          <div className="accent-row">
            {chips.map((c, i) => (
              <button
                key={c}
                className={`accent-chip ${shown === c ? 'on' : ''} ${i === 0 ? 'own' : ''}`}
                style={{ background: c, color: onColor(c) }}
                title={i === 0 ? `${current.name}'s own` : c}
                onClick={() => set({ accent: i === 0 ? '' : c })}
              >
                {shown === c && <Check size={13} />}
              </button>
            ))}
            <label className={`accent-chip custom ${chips.includes(shown) ? '' : 'on'}`} title="Pick any color" style={{ background: chips.includes(shown) ? undefined : shown }}>
              <input type="color" value={shown} onChange={(e) => set({ accent: e.target.value })} />
              {!chips.includes(shown) && <Check size={13} style={{ color: onColor(shown) }} />}
            </label>
            {isHexColor(accent) && (
              <button className="btn sm" onClick={() => set({ accent: '' })}>
                <RotateCcw size={12} /> Theme's own
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function ThemeCard({ t, on, accent, onPick }: { t: Theme; on: boolean; accent?: string; onPick: () => void }) {
  const k = t.tokens
  const a = accent ?? k.accent
  return (
    <button className={`theme-card ${on ? 'on' : ''}`} onClick={onPick}>
      <div className="theme-prev" style={{ background: k.board, backgroundImage: `radial-gradient(circle, ${k.dot} 1px, transparent 1.2px)`, borderColor: k.line }}>
        <div className="theme-prev-node" style={{ background: k.panel, borderColor: k.line }}>
          <div className="theme-prev-head" style={{ background: k['panel-2'], borderColor: k.line }}>
            <span style={{ background: k.ok }} />
            <i style={{ background: k['text-2'] }} />
          </div>
          <div className="theme-prev-term" style={{ background: t.term.background }}>
            <i style={{ background: t.term.green, width: '38%' }} />
            <i style={{ background: t.term.foreground, width: '62%', opacity: 0.7 }} />
            <i style={{ background: t.term.blue, width: '30%' }} />
            <i style={{ background: a, width: 5 }} />
          </div>
        </div>
        <div className="theme-prev-side" style={{ background: k.panel, borderColor: k.line }}>
          <i style={{ background: k.text, width: '70%' }} />
          <i style={{ background: k.muted, width: '50%' }} />
          <b style={{ background: a, color: onColor(a) }} />
        </div>
      </div>
      <div className="theme-meta">
        <span className="theme-name">
          {t.name}
          {on && <Check size={12} />}
        </span>
        <span className="theme-blurb">{t.blurb}</span>
      </div>
    </button>
  )
}
