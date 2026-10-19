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

```bash
npm test           # unit tests, including replays of real recorded CLI sessions
npm run test:e2e   # the built app driven end to end under Xvfb, with a scripted claude
# by hand, with the real CLIs (see docs/ARCHITECTURE.md, Testing):
#   FLEETBOARD_REAL_CLAUDE_CONFIG=~/.claude   test/e2e/real/{team,console,sessions}.test.ts
#   FLEETBOARD_REAL_CODEX=$(which codex)      test/e2e/real/codex-*.test.ts   (local mock model, no account)
#   FLEETBOARD_REAL_GEMINI=$(which gemini)    test/e2e/real/gemini-sessions.test.ts
```

## What's on the board

| Area | What you get |
|---|---|
| **Board** | Infinite canvas with pan/zoom, workspaces as tabs, each console a real PTY (Ctrl‑C, vim, htop all work). Kanban, calendar, sticky notes, checklists, text, ink and shapes, images you can mark up, live web tiles with device presets and an inspector, and a git card with commit & push. |
| **Voice** | Hold <kbd>Space</kbd> (or <kbd>Alt</kbd>+<kbd>Space</kbd> anywhere) to speak. Whisper runs on-device. A fast local parser handles common commands; anything else goes to a planner that runs through your own `claude -p`. Replies are spoken with Kokoro on-device. Destructive steps wait for "confirm". Dictation to `@name` only types: you press Enter. |
| **Orchestration** | Status per console (working / ready / needs you) read from what each terminal actually shows, plus Claude Code's hooks; a question on screen becomes an Inbox card with its real options, and nothing the board types ever answers one for you. Mission map, orchestrator with @mentions, teams with roles, a composer for up to 12 consoles, handoffs that summarize one session and brief the next agent, and loops that run on a schedule, on idle or on output, then retire once their goal is met. |
| **Studios** | Documents (streamed from your repo, exported as a paginated PDF), Diagrams (hand-drawn figures added to the board, exported as PNG or `.excalidraw`), a Code studio, and an Obsidian-style Markdown vault with a link graph. |
| **Continuity** | Boards save on every change. Reopening relaunches every console in place and offers to resume through each CLI's own resume. You also get token analytics from local session logs, account profiles (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), project and global memory, a Skills manager and settings. |

## Where things live

- App state: `~/.fleetboard/` (versioned JSON, with rolling snapshots in `history/`)
- Account profiles: `~/.fleetboard/profiles/<id>/`
- Nothing is uploaded. The only network traffic comes from the agent CLIs you run, one-time model downloads from Hugging Face (speech and voice), and whatever you open in a web tile.

## Teams: give it a goal, not a task list

Type (or say) what you want in the command bar, for example *"add a Split PDF command with tests"*. Anything that isn't a board command goes to a **Lead**, created automatically:

1. The Lead reads the repo and puts a **plan** on the board.
2. It starts **workers**, one per task, each in its own git worktree with files only it owns, and briefs them.
3. Workers report back; their work is committed automatically and the Lead merges it.
4. A read-only **reviewer** checks the combined result and runs the checks; findings go back to the owner.
5. A **Ready** card appears in your Inbox: **Merge** brings the branch into your checkout and dismisses the team.

Everything that needs you lands in the **Inbox** (top right): the Lead's questions as buttons, every agent's permission prompt as *Allow once / Always allow … / Deny*, and the Ready card. Your own uncommitted work is never touched: the team works from your last commit in separate worktrees. (That needs a git repository with a commit; in a folder without one, Fleetboard asks before the team works in your files directly.)

Under the hood each team console is connected to a local MCP server (`fleet_plan`, `fleet_spawn_worker`, `fleet_send`, `fleet_wait`, `fleet_merge`, `fleet_ask_user`, `fleet_finish`, `fleet_report`), so it works with Claude Code, Codex and any CLI that speaks MCP.

## The Inbox on your phone

Agents wait while you're away from the desk. **Settings → Phone Inbox** serves the Inbox to your phone: approvals with the same buttons as on the board, the Lead's questions, the Ready card (Merge asks first), and a read-only view of each console. Scan the QR code to open it.

- **Off until you turn it on.** While it is on, the top bar shows a **Phone** badge.
- **Tailscale** (recommended): listens on this computer's Tailscale address only; the connection is encrypted and works from anywhere on your tailnet. **Wi-Fi**: your local network address, plain HTTP (anyone who can see that network's traffic could copy the link). **This PC**: 127.0.0.1, to try it. It follows the address: when Tailscale connects after the app started, or Wi-Fi hands out a new one, it moves there (the QR code in Settings updates).
- The link carries a long secret in its `#fragment` (never sent in URLs, logs or referrers). **New link** revokes the old one at once. Answers are checked against the live screen first, so a stale phone never types into a console whose question was already answered.

## Helm and playbooks

**Helm** (the ship-wheel toggle in the command bar, on by default) reads the whole board: every console's recent output, the team's plan, kanban cards, checklists, notes, git state. Ask it anything ("what is everyone doing?", "who needs me?") or say what you want done, and it answers or offers 1–3 one-click routes: a playbook with its inputs filled in, a goal for the Lead, a message to the agent already working on it, board actions, or a panel. Enter on an empty bar takes the first route. Instant board commands (zoom, pause, spawn…) and `@name` messages still go straight through.

**Playbooks** (Presets → Playbooks) are work you do regularly, as one-click cards. Each starts its own Lead with a proven brief:

| | Playbook | What it does |
|---|---|---|
| Daily | Ship a feature → PR | Plan, build in parallel, review, then *Open draft PR* from the Ready card |
| | Hotfix | Reproduce, pin with a failing test, minimal fix, review |
| | Next PLAN.md item | Proposes the next unchecked item for your OK, builds it, ticks it off |
| | Morning sweep | Read-only health check across all your repos (built in, no agents) |
| Upkeep | Get to green | Run every check, split failures by area, fix until all pass |
| | Test coverage sweep | Rank untested logic by risk, a test writer per module |
| | Docs drift check | Fix docs that no longer match the code (docs only) |
| | Database safety pass | Review migrations/RLS and run DB checks; fixes only with your yes |
| Occasional | PR review round | A reviewer per open PR; verdicts in your Inbox, nothing posted |
| | Dependency refresh | Patch/minor updates verified by your checks; majors listed |
| | UI polish pass | Live preview tile + a team refining what you point at |

The **Morning sweep** (also on the home screen) checks every repo under `~/code`, `~/Github`, … without changing anything: uncommitted work and how old it is, open PRs and their review state, CI on the default branch, stale branches, upstream drift, the next PLAN.md item. *Brief me* turns it into a short morning brief.

## CI and review watcher

With the GitHub CLI signed in (`gh auth login`), the badge next to the branch name shows the open repo's GitHub Actions: **CI passing**, **running** or **failing**, plus how many open PRs are red. It checks every minute (every 20s while something is running) and tells you when a run turns red or goes green again, with a desktop notification when Fleetboard isn't in front.

Click the badge for the CI drawer: the latest run of each workflow on your branch and every open PR's checks. On anything red, **Failed log** shows where it failed, and **Fix it** starts a *CI fixer* console with that log, told to fix the cause (never by weakening a test), run the checks locally and push. A PR on another branch gets its own git worktree, so your checkout isn't touched. Switch on **Fix failures automatically** to have that happen on its own whenever a run turns red.

Review comments are watched too (every two minutes): PR comments, review summaries and inline comments on unresolved threads. When new ones land on a PR an agent made (a team's branch, or one Fleetboard already sent an agent to), they go straight to that agent: its Lead or console if it's still running, otherwise a new *PR #N fixer* console in that branch. The agent is told to address each point, push, and reply on the PR starting with 🤖, so its replies are never sent back to it. Comments on other PRs only notify you; the drawer has **Send to …** and **Mark handled** for those. A CI failure on a PR with an agent on it goes to that agent as well. Bots' plain comments (deploy previews, coverage), bare approvals and resolved threads are left out.

Helm sees all of this. Ask "what needs me?" or "what should I work on?" and it weighs open questions, red CI, unsent review comments and PRs waiting on you (plus the last morning sweep of your other repos), then offers one-click **Fix CI** / **Send the comments** options.

## Navigation (AutoCAD-style by default)

| Input | Action |
|---|---|
| Scroll wheel | Zoom in/out at the cursor (consoles and lists still scroll; hold <kbd>Ctrl</kbd> to zoom over them) |
| Middle-drag | Pan, from anywhere on the board |
| Double-middle-click, <kbd>Home</kbd>, <kbd>Z</kbd> <kbd>E</kbd> | Zoom extents: fit everything |
| <kbd>Z</kbd> <kbd>P</kbd> | Zoom previous |
| <kbd>Z</kbd> <kbd>W</kbd> | Zoom window: drag the area to zoom into |
| <kbd>Z</kbd> <kbd>O</kbd> | Zoom to the selection |
| Left-drag, left → right | Window select: only fully enclosed items (blue) |
| Left-drag, right → left | Crossing select: anything touched (green, dashed) |
| <kbd>Shift</kbd>+drag | Add to the selection |
| <kbd>Shift</kbd>+scroll / <kbd>Alt</kbd>+scroll | Pan sideways / up and down |
| Minimap (bottom right) | Click or drag to move the view |

### Focus mode

Click anywhere on a tile (or press <kbd>F</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) and the camera glides into it: it fills the board at true 100% scale, so terminals gain columns and web tiles get a real viewport, while the rest of the board dims. Hop between consoles with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd>. **Back to board**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>, <kbd>Esc</kbd> (outside a terminal), a click on the dimmed board or <kbd>Ctrl</kbd>+scroll out glides back to exactly the zoom and position you had. The first click on a zoomed-out tile only zooms (it never ticks, types or follows a link); drag a tile's body or header to move it, <kbd>Shift</kbd>+click to select without zooming, and at 90% zoom or closer clicks go straight to the content.

Prefer trackpad-style (scroll pans, drag pans)? Switch it in **Settings → Navigation**.

## Keyboard

| Keys | Action |
|---|---|
| Hold <kbd>Space</kbd> | Push to talk (when no terminal or input has focus) |
| <kbd>Alt</kbd>+<kbd>Space</kbd> | Push to talk from anywhere |
| <kbd>Ctrl</kbd>+<kbd>=</kbd>/<kbd>-</kbd>, <kbd>Ctrl</kbd>+<kbd>0</kbd>, <kbd>Ctrl</kbd>+<kbd>1</kbd> | Zoom in/out, fit, 100% |
| <kbd>V</kbd> <kbd>P</kbd> <kbd>R</kbd> <kbd>T</kbd> <kbd>E</kbd> | Select, pen, shapes, text, eraser |
| <kbd>Delete</kbd> | Remove selection (live consoles ask first) |
| Double-click a node header | Focus / back to board |

Middle-click paste is disabled on the board (middle button pans); paste into a console with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.
