# Fleetboard

A visual board of real terminals for your AI coding agents. Put Claude Code, Codex, Gemini and 30 other agent CLIs on one board, then pan, zoom, group, loop and talk to them. Everything runs on your machine with the subscriptions you already have.

This is a personal rebuild of [Symvibe](https://www.symvibe.com/)'s feature set for Linux. See [docs/RESEARCH.md](docs/RESEARCH.md) for the teardown and the feature ledger, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is organized.

## Run it

```bash
npm install --ignore-scripts && npx electron-rebuild -f -w node-pty
```

```bash
npm run dev        # hot-reloading dev app
```

```bash
bin/fleetboard     # build once, then launch
```

```bash
scripts/install-desktop.sh   # add it to your app launcher
```

## What's on the board

| Area | What you get |
|---|---|
| **Board** | Infinite canvas with pan/zoom, workspaces as tabs, each console a real PTY (Ctrl‑C, vim, htop all work). Kanban, calendar, sticky notes, checklists, text, ink and shapes, images you can mark up, live web tiles with device presets and an inspector, and a git card with commit & push. |
| **Voice** | Hold <kbd>Space</kbd> (or <kbd>Alt</kbd>+<kbd>Space</kbd> anywhere) to speak. Whisper runs on-device. A fast local parser handles common commands; anything else goes to a planner that runs through your own `claude -p`. Replies are spoken with Kokoro on-device. Destructive steps wait for "confirm". Dictation to `@name` only types: you press Enter. |
| **Orchestration** | Status per console (working / ready / needs you) from Claude Code hooks plus output heuristics. Mission map, orchestrator with @mentions, teams with roles, a composer for up to 12 consoles, handoffs that summarize one session and brief the next agent, and loops that run on a schedule, on idle or on output, then retire once their goal is met. |
| **Studios** | Documents (streamed from your repo, exported as a paginated PDF), Diagrams (hand-drawn figures added to the board, exported as PNG or `.excalidraw`), a Code studio, and an Obsidian-style Markdown vault with a link graph. |
| **Continuity** | Boards save on every change. Reopening relaunches every console in place and offers to resume through each CLI's own resume. You also get token analytics from local session logs, account profiles (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), project and global memory, a Skills manager and settings. |

## Where things live

- App state: `~/.fleetboard/` (versioned JSON, with rolling snapshots in `history/`)
- Account profiles: `~/.fleetboard/profiles/<id>/`
- Nothing is uploaded. The only network traffic comes from the agent CLIs you run, one-time model downloads from Hugging Face (speech and voice), and whatever you open in a web tile.

## Navigation (AutoCAD-style by default)

| Input | Action |
|---|---|
| Scroll wheel | Zoom in/out at the cursor (consoles and lists still scroll; hold <kbd>Ctrl</kbd> to zoom over them) |
| Middle-drag | Pan, from anywhere on the board |
| Double-middle-click, <kbd>Home</kbd>, <kbd>Z</kbd> <kbd>E</kbd> | Zoom extents: fit everything |
| <kbd>Z</kbd> <kbd>P</kbd> | Zoom previous |
| <kbd>Z</kbd> <kbd>W</kbd> | Zoom window: drag the area to zoom into |
| <kbd>Z</kbd> <kbd>O</kbd> or <kbd>F</kbd> | Zoom to the selection |
| Left-drag, left → right | Window select: only fully enclosed items (blue) |
| Left-drag, right → left | Crossing select: anything touched (green, dashed) |
| <kbd>Shift</kbd>+drag | Add to the selection |
| <kbd>Shift</kbd>+scroll / <kbd>Alt</kbd>+scroll | Pan sideways / up and down |
| Minimap (bottom right) | Click or drag to move the view |

Prefer trackpad-style (scroll pans, drag pans)? Switch it in **Settings → Navigation**.

## Keyboard

| Keys | Action |
|---|---|
| Hold <kbd>Space</kbd> | Push to talk (when no terminal or input has focus) |
| <kbd>Alt</kbd>+<kbd>Space</kbd> | Push to talk from anywhere |
| <kbd>Ctrl</kbd>+<kbd>=</kbd>/<kbd>-</kbd>, <kbd>Ctrl</kbd>+<kbd>0</kbd>, <kbd>Ctrl</kbd>+<kbd>1</kbd> | Zoom in/out, fit, 100% |
| <kbd>V</kbd> <kbd>P</kbd> <kbd>R</kbd> <kbd>T</kbd> <kbd>E</kbd> | Select, pen, shapes, text, eraser |
| <kbd>Delete</kbd> | Remove selection (live consoles ask first) |
| Double-click a node header | Maximize / restore |

Middle-click paste is disabled on the board (middle button pans); paste into a console with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.
