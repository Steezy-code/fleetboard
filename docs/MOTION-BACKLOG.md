# Motion effects

First pass: directional message pulses, agent activation, coordinated Tidy/focus transitions,
and Off / Subtle / Full settings that honor system reduced motion.

Second pass (implemented):

- New terminal materialization: short fade and scale with illuminated corner brackets.
- Completion cascade: finished workers illuminate toward the lead, then reveal the Ready card.
- Attention beacon: two amber rings when an agent needs input, with a matching minimap signal.
- Oracle response: thinking orbit and audio-reactive listening/speaking halo.
- Magnetic docking: highlight valid drop targets and settle cards into place.
- Coordinated group expansion/collapse transitions.

Keep effects theme-aware, leave terminal text stable, and animate meaningful events.

Settings → Appearance → Motion defaults to Subtle. Full increases the accents and timing;
Off and the system reduced-motion preference disable movement while preserving status markers.
Full holds activation traces for 1.7 seconds, terminal corners for 1.3 seconds, and message packets
for 1.1 seconds with a larger arrival ring. Layout/focus transitions take 700 ms, attention rings
last 1.65 seconds together, and completion highlights linger with staggered worker/lead/card stages.
The Oracle halo follows mic RMS and synthesized speech PCM; system speech uses a gentle fallback
pulse because the system voice API does not expose audio samples. Completion highlights only
reported/merged workers and never delays or disables the Ready card's controls.
