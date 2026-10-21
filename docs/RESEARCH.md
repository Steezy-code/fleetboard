# Fleetboard feature spec

What each feature does and looks like. `docs/ARCHITECTURE.md` covers how the code is organized.

## Visual language

- Near-black board (`#0f0d0c`) with a faint dot grid; warm off-white text; **one accent: red-orange** (`#ff4a2b`) used for active tab, primary buttons, selection, status dots.
- Fonts: Geist (UI), JetBrains Mono (consoles), Fraunces italic (display).
- **Top bar:** `← Back to home` · project selector (`▣ <project> ⌄`) · workspace tabs (active tab tinted red with a count badge) · `+` · `× Close` · right side: `● N live`, usage pill (`◔ resets <time>`), briefcase, settings, avatar.
- **Left tool rail (vertical):** select (red when active), agent spawn, shapes, web/monitor, `Aa` text, pen/ink, eraser/tag, globe (web tile), image, connector.
- **Right rail:** layers, checklist, settings/gear, folder (code), doc, markdown, loops.
- **Bottom center:** chip row `New console · Spawn N · Group · Presets · Pause all · Resume all · Memory`, then a pill command bar with an orb icon: “Hold space to speak · @ to direct…”, chevron, stop, mic. Hint pill above: `Try "pass this task to codex"`. While listening: `● listening ▮▮▮` with live transcript caption below.
- **Bottom left:** git branch `⎇ main N`. **Bottom right:** zoom `− N% +`.
- **Console node:** title bar with colored agent dot + name (`Maya 2`), status pill (`● WORKING` red, `READY`, `YOLO`), buttons (duplicate, maximize, close). Body is the real terminal.
- **Group frame:** dashed/rounded frame with header `● REVIEWERS N · idle ⌄`, tinted by role. Wires (curved red lines with dots) connect the Orchestrator node to groups.

## Feature ledger

Each row: what the feature is → how Fleetboard does it.

### 01 Board
- Real PTY terminals (Ctrl-C, vim, htop work) → `node-pty` + xterm.js (WebGL renderer) per console node.
- Infinite board, pan/zoom, many workspaces per project switched like tabs → camera transform over a DOM node layer; workspaces in the top bar.
- Presets lay out a board in one tap → preset gallery (2×2 Claude, Claude+Codex+Gemini, review squad, etc.).
- **Live web tiles** with URL bar, quick-open grid (localhost ports, Google, YouTube, etc.), device presets (Fit tile, 24"/27"/32" 4K monitors, iPhone SE/14 Pro/14 Pro Max, Pixel 7, Galaxy S8+), docked inspector → Electron `<webview>` node + `openDevTools`.
- **Kanban** (Backlog / To do / In progress / Done, cards with due chip and priority, add column, drag columns, move to start/end), **calendar** (month grid, New event, title/date/all-day/color), **sticky notes** (paper colors), **checklist** (“objectives”), **text** (font, size, align, color, opacity).
- **Ink and markup**: freehand pen with color + width palette, shapes (rect/ellipse/diamond/line/arrow), stroke/background/style/sloppiness/edges/opacity; draw over dropped images.
- **Git on the board**: card with repo, branch, CHANGES list with per-file status, commit message, `Commit & Push N files`, history, pull/refresh, “Working tree clean”.

### 02 Voice
- Push-to-talk (hold Space), transcribed on-device → Whisper via `@huggingface/transformers` in the renderer, downloaded once from Hugging Face.
- Planner turns plain speech + a board snapshot into actions (“spawn 5 claude code agents”, “now spawn 2 codex”, “put an orchestrator wire with group 1”, “delete the group called backend”) → planner runs through **your own `claude -p`** (no API key) returning a JSON plan; a fast local rule parser handles common commands instantly and offline.
- Spoken replies in a natural voice (“DAX, Maya2, Rafa2, Nova2, about to close 4 consoles, say confirm”) → Kokoro TTS on-device (fallback: system speech).
- Destructive steps wait for confirmation; dictation only types, Enter is yours.

### 03 Orchestration
- Status per console: working / resting (idle) / needs you, driven by CLI hooks → Claude Code hooks via a per-console settings file, plus output heuristics for every other CLI (activity timing + prompt patterns).
- **Mission map** modal: filter chips (All, Working, Needs you, Idle, Done), search, tree Orchestrator → Teams → consoles, side panel with Fleet counts (Working/Needs you/Idle/Done; Orchestrators/Teams/Consoles/Active loops), selection details with `Go to the console`, Pause, Kill.
- **Orchestrator** panel: “N agents · M groups”, list with live status, `Command N agents…` input; it types the command into the named consoles and submits.
- **Teams**: groups with roles (Frontend, Backend, Testers, Reviewers, Design, Docs, Security, General) and tints.
- **Composer**: up to 12 slots, per-slot agent, “Fill all” with an agent, `Spawn N`.
- **Handoff**: “pass this task to codex” → outgoing scrollback summarized by a CLI, brief typed into the new agent.
- **Loops**: templates (Progress check, Keep them moving, Build rescue, Test watchdog, Commit checkpoint, Review sweep, Hourly…), name, instruction, WHEN (On a schedule 5m/10m/15m/30m/1h/2h · When an agent goes idle · When output contains…), TARGET (All consoles / Pick consoles), STOP (after N runs / after a time limit / when a goal is met: a command passes or an agent judges, e.g. `ALL GREEN`), BEHAVIOR (keep running behind other tabs). Summary line: “Every 15 min, the instruction is sent to every console on the board, until Claude judges the goal met.”

### 04 Studios
- **Documents**: presets (Project overview, Onboarding guide, Architecture, README, API reference, Data model, Security overview), depth (Quick / Balanced / Thorough), model picker, streaming live preview on a white page, `Stop`, export real paginated PDF, place card on board, “Ask for anything” custom prompt.
- **Diagrams**: from your project (Architecture, User flow, Data flow, Components, Request lifecycle, State flow) or describe one; starter shapes (Flow, Steps, Decision branch, Mind map); style Ink / Colorful; spills onto the board as loose hand-drawn figures; export PNG / `.excalidraw`.
- **Code**: file tree, highlighted preview, edit + Save, Add folder, `Insert` (pin file as a node on the board).
- **Markdown vault**: tree + search, Reading / Source / Graph modes, autosave, force-directed link graph, Add to Board, Export PDF.

### 05 Continuity
- Workspace saved on every change as versioned JSON; on reopen each console relaunches in place and offers to resume (“Resume all conversations? Yes / No”, per-console “Resume last conversation?”) via the CLI’s native resume (`claude --continue`, `codex resume --last`, …).
- **Usage**: pill per CLI (session %, weekly %, resets at), activity heatmap, Tokens view (last 30 days bars, by-agent totals) from local session logs (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**`).
- **Accounts / profiles**: per-CLI profiles with isolated config dirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), “Save your current sign-in as a profile”, `Use`, connect another account.
- **Project memory**: per-repo and global memory cards with categories (Context, Architecture, Structure, Commands, Conventions, Gotchas), `Scan repo` with a CLI that proposes facts for review, `New memory`, push to consoles only on demand, “Place card on board”.

### Settings / safety
- Auto-approval flags (`--dangerously-skip-permissions`, `--yolo`, etc.) are a global opt-in, off by default.
- Killing a live console always asks first. Quit with running consoles asks first.

## Deliberate choices
- Linux and Windows, on Electron.
- No account, no credits, no hosted planner: the planner, studios, handoffs and loop judges all run through the CLIs you are already logged into.
- All state in `~/.fleetboard/`.
