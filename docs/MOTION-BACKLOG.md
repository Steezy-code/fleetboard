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

Third pass (implemented):

- Workspace switching: the incoming board settles forward from slightly receded. Trigger: click
  another tab, add or close a workspace, or anything that moves `activeWorkspaceId`.
- Wire creation: while the connector holds a source, a dashed curve follows the pointer from that
  item's edge; the finished wire lights once from end to end. Trigger: Connect in the left rail,
  click one item, move, click another. Escape, another tool, a workspace switch or the source being
  removed all cancel it.
- Inbox arrival: a card that is genuinely new enters with a short rise and one glow across the tray.
  Trigger: a new item reaching the Inbox. A refresh that rebuilds the same items, and Tab between
  cards, deliberately stay still.
- Sticky note creation: the paper unfolds from where it was put down and settles. Trigger: the note
  tool, or any new `note` tile. Moving, undoing or revisiting an existing note does not replay it.
- Zoom detail: below 50% cards trade their body for a large label, and get the detail back above
  62%. The gap is hysteresis, so a trackpad resting on the threshold does not flicker. Status,
  selection and needs-you markers stay visible at every zoom.
- Multi-selection: the frames joining the selection are acknowledged once and a quiet dashed
  boundary is drawn around the whole set. Trigger: select a second item (Shift-click, marquee,
  Ctrl+A). It lives in board coordinates, so it pans and zooms with the items, and takes no clicks.

Known limits of this pass: a workspace switch animates only the incoming board — the outgoing one is
unmounted by the board's `key` before it could be animated, and keeping it alive would re-mount the
live terminals on the board being left. The connector's preview line is drawn at every motion level,
Off included, because it is an affordance rather than decoration; what Off removes is the dash
marching along it. Compact labels replace the body of framed cards only: chromeless tiles (notes,
text, images) are already their own content and are left alone.
