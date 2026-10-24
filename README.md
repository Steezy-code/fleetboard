# Fleetboard

A visual board of real terminals for your AI coding agents. Put Claude Code, Codex, Gemini and 30 other agent CLIs on one board, then pan, zoom, group, loop and talk to them. Everything runs on your machine with the subscriptions you already have.

A personal project, for Linux and Windows. See [the hardening guide](docs/HARDENING.md) for observed verification, integration support tiers, recovery, accessibility and performance checks. See [docs/RESEARCH.md](docs/RESEARCH.md) for the feature spec — what each feature does and looks like — and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is organized.

## Run it

```bash
npm install        # builds node-pty for Electron (Windows uses node-pty's prebuilt binary)
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
npm run lint       # oxlint, errors only
npm run test:e2e   # the built app driven end to end under Xvfb, with a scripted claude
#   FB_E2E_JOBS=3     several files at a time (what CI does; races show up under load)
#   FB_E2E_HEADLESS=1 no Xvfb needed
#   FB_E2E_KEEP=1     keep every test's temp sandbox (a failed test's is always kept, and named in its output)
#   npm run test:e2e:one -- test/e2e/<file>.test.ts
FB_E2E_HEADLESS=1 npm run bench # opt-in 20/50-terminal responsiveness benchmark
npm run test:linux # on Windows: the Linux unit + e2e suites in a container (needs Docker)
#   npm run test:linux -- unit    the quick half
#   26 of the 28 e2e files and 8 unit files never run on Windows; this is that ground, before CI sees it
# by hand, with the real CLIs (see docs/ARCHITECTURE.md, Testing):
#   FLEETBOARD_REAL_CLAUDE_CONFIG=~/.claude   test/e2e/real/{team,console,sessions,handoff}.test.ts
#   FLEETBOARD_REAL_CODEX=$(which codex)      test/e2e/real/codex-*.test.ts   (local mock model, no account)
#   FLEETBOARD_REAL_GEMINI=$(which gemini)    test/e2e/real/{gemini-sessions,gemini-team}.test.ts
```

## Windows

Grab **Fleetboard-Setup-<version>.exe** from the [Releases](https://github.com/Steezy-code/fleetboard/releases) page (you need to be signed in to GitHub: the repo is private) and run it. It installs for your user only, with Start-menu and desktop shortcuts. The installer isn't code-signed, so SmartScreen may warn: **More info → Run anyway**.

Then install your agent CLIs in Windows as usual (Claude Code, Codex, Gemini…) and sign in to each once in a terminal. Fleetboard finds them on your PATH, including ones npm installed as `.cmd` wrappers. Git for Windows and the GitHub CLI (`gh`) are needed for teams, the git card and the CI watcher.

What's different on Windows:
- Shell consoles are PowerShell (PowerShell 7 when installed, else Windows PowerShell).
- **Pause** freezes the console's whole process tree through Windows' own suspend, since there is no `SIGSTOP` there. It takes about a second to take effect, and it is a real freeze: a paused agent is not quietly still working. Closing a console ends everything it started, paused or not.
- The window uses the system's own minimize / maximize / close buttons, with Snap Layouts.
- Claude Code's status hooks run through a small script (with Node when it's installed, else PowerShell).
- Teams link dependencies into their worktrees with junctions, which need no admin rights.

Settings shows which build you are running, and tells you when a newer release is out (one `gh release view`, once a launch); a chip appears in the top bar and opens the release page. Nothing downloads or installs itself.

Releases are built on Windows by CI: push a tag like `v0.2.0` (or `v0.2.0-win.1` for a pre-release) and `.github/workflows/release.yml` builds the installer and attaches it to a GitHub Release. `npm run dist:win` builds one on a Windows machine.

Every CI job runs on a **self-hosted runner**: the Windows jobs in both workflows on a Windows machine (a hosted Windows runner bills at twice a Linux one), and ci.yml's Linux `checks` job on a Linux one (self-hosted minutes are free, and hosted runners stop starting jobs whenever the account's billing does). That only stays safe while this repo is private: on a public repo a fork's pull request would run its own code on those machines. The Linux runner needs `xvfb-run` installed once (Arch: `xorg-server-xvfb`; Debian/Ubuntu: `xvfb`), since the job has no sudo; here it runs as a systemd user service, `actions-runner.service`, from `~/actions-runner`. One thing that runner needs, or every `shell: bash` step dies with `execvpe(/bin/bash) failed`: **`C:\Program Files\Git\bin` must come before `C:\Windows\System32` on its PATH**, so `bash` is Git Bash and not the WSL shim. Naming the path in the workflow instead does not work — the runner cannot parse a custom shell whose path contains spaces. Here it is done by starting the runner through a wrapper that prepends Git's bin (`run-gitbash-first.cmd` beside `run.cmd`, which the logon task points at).

## What's on the board

| Area | What you get |
|---|---|
| **Board** | Infinite canvas with pan/zoom, workspaces as tabs, each console a real PTY (Ctrl‑C, vim, htop all work). Kanban, calendar, sticky notes, checklists, text, ink and shapes, images you can mark up, live web tiles with device presets and an inspector, and a git card with commit & push. New tiles land as near the middle of your view (or the tile they belong to) as they fit without covering anything; a group folds to its header while its consoles keep running; **Tidy** packs the board into rows, keeping teams and groups together (with Undo); **Clear finished** removes consoles whose programs have ended. |
| **Voice** | Hold <kbd>Space</kbd> (or <kbd>Alt</kbd>+<kbd>Space</kbd> anywhere) to speak. Whisper runs on-device. A fast local parser handles common commands; anything else goes to a planner that runs through your own `claude -p`. Replies are spoken with Kokoro on-device. Destructive steps wait for "confirm". Dictation to `@name` only types: you press Enter. |
| **Orchestration** | Status per console (working / ready / needs you) read from what each terminal actually shows, plus Claude Code's hooks; a question on screen becomes an Inbox card with its real options, and nothing the board types ever answers one for you. Mission map, orchestrator with @mentions, teams with roles, a composer for up to 12 consoles, handoffs that summarize one session and brief the next agent, and loops that run on a schedule, on idle or on output, then retire once their goal is met. |
| **Studios** | Documents (streamed from your repo, exported as a paginated PDF), Diagrams (hand-drawn figures added to the board, exported as PNG or `.excalidraw`), a Code studio, and an Obsidian-style Markdown vault with a link graph. |
| **Continuity** | Boards save on every change. Reopening relaunches every console in place and offers to resume through each CLI's own resume. You also get token analytics from local session logs, account profiles (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), project and global memory, a Skills manager and settings. |

## Where things live

- App state: `~/.fleetboard/` (versioned JSON, with rolling snapshots in `history/`)
- Account profiles: `~/.fleetboard/profiles/<id>/`
- Nothing is uploaded. The only network traffic comes from the agent CLIs you run, one-time model downloads from Hugging Face (speech and voice), and whatever you open in a web tile.

## Teams: give it a goal, not a task list

Type (or say) what you want in the command bar, for example *"add a Split PDF command with tests"*. An empty board offers up to three goals read from the repo itself (the next unchecked item in PLAN.md, a TODO left in the code, a missing README or tests); a click puts one in the bar and Enter is still yours. Anything that isn't a board command goes to a **Lead**, created automatically:

1. The Lead reads the repo and puts a **plan** on the board.
2. It starts **workers**, one per task, each in its own git worktree with files only it owns, and briefs them.
3. Workers report back; their work is committed automatically and the Lead merges it.
4. A read-only **reviewer** checks the combined result and runs the checks; findings go back to the owner.
5. A **Ready** card appears in the Inbox on the command bar: **Merge** brings the branch into your checkout and dismisses the team.

Everything that needs you lands in the **Inbox**, docked on top of the command bar: every agent's permission prompt (with what it was just doing, the command, and a plain note like "Runs your tests"), the Lead's questions (each option with its trade-off, and the one the Lead would pick), the Ready card (what changed, files with lines added and removed, what the Lead verified), and notices like red CI or review comments. The front item shows in full; **Show all** (Ctrl+I) lists the rest.

When a worker asks to run a command, **Allow for the team** says yes once for the whole team: the same command asked by any of its members is answered for you until the team is merged or discarded. It matches the exact command only (never a prefix), and never applies to commands that delete, overwrite, run as root or reach the network. The team's rules show on its next approval card, each with an × to take it back. Every answer a rule gives is in the Night log.

Come back after ten minutes or more away (the window lost focus, or nobody touched the computer) and the Inbox opens on **While you were away**: finished work, the Lead's questions, workers' reports, prompts answered for you (by a team rule or from your phone), spend limits hit, loops that ran and consoles that crashed. **Night log** has the rest.

From the bar: **1**–**9** pick a button, **Enter** on an empty bar runs the highlighted one, **Tab** / **Shift+Tab** step through the items. When a question or a Ready card is in front, a tag shows who you're talking to and what you type goes to that agent; with a permission prompt in front, typing still goes to Oracle, so a stray sentence never approves anything. Saying "allow", "deny", "merge" or "option two" answers the front item by voice. Keys wait a moment after a new card appears, so a keystroke meant for something else can't answer it. In focus mode the tray floats in the corner.

Your own uncommitted work is never touched: the team works from your last commit in separate worktrees. (That needs a git repository with a commit; in a folder without one, Fleetboard asks before the team works in your files directly.)

Under the hood each team console is connected to a local MCP server (`fleet_plan`, `fleet_spawn_worker`, `fleet_send`, `fleet_wait`, `fleet_merge`, `fleet_ask_user`, `fleet_finish`, `fleet_report`), so it works with Claude Code, Codex and any CLI that speaks MCP.

## The Inbox on your phone

Agents wait while you're away from the desk. **Settings → Phone Inbox** serves the Inbox to your phone: approvals with the same buttons as on the board, the Lead's questions, the Ready card (Merge asks first), and a read-only view of each console. Scan the QR code to open it.

- **Off until you turn it on.** While it is on, the top bar shows a **Phone** badge.
- **Tailscale** (recommended): listens on this computer's Tailscale address only; the connection is encrypted and works from anywhere on your tailnet. **Wi-Fi**: your local network address, plain HTTP (anyone who can see that network's traffic could copy the link). **This PC**: 127.0.0.1, to try it. It follows the address: when Tailscale connects after the app started, or Wi-Fi hands out a new one, it moves there (the QR code in Settings updates).
- The link carries a long secret in its `#fragment` (never sent in URLs, logs or referrers). **New link** revokes the old one at once. Answers are checked against the live screen first, so a stale phone never types into a console whose question was already answered.

## Oracle and playbooks

**Oracle** (the sparkles toggle in the command bar, on by default) reads the whole board: every console's recent output, the team's plan, kanban cards, checklists, notes, git state. Ask it anything ("what is everyone doing?", "who needs me?") or say what you want done, and it answers or offers 1–3 one-click routes: a playbook with its inputs filled in, a goal for the Lead, a message to the agent already working on it, board actions, or a panel. Enter on an empty bar takes the first route. Instant board commands (zoom, pause, spawn…) and `@name` messages still go straight through.

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

### Brainstorm

Type or say **"brainstorm …"** (or click **Brainstorm** above the bar) and a panel of three agents thinks about it in parallel: a **pragmatist** (best value for the effort, shippable this week), a **wild card** (the bold 10x version) and a **critic** (what's weak or missing today, turned into fixes). Each reads your project, read-only, from its own angle. When you have several CLIs installed the seats go to different ones (Claude Code, Codex, Gemini…), so you get different models' takes; if one can't run (not signed in, folder not trusted), the planner's CLI takes its seat and the card says why. Oracle then merges duplicates and ranks the ideas.

It all lands on the board as one **Brainstorm** card: the panel's live progress, then the ideas best first, each with effort, impact and which panelists had it. Every idea has **Give to team** (a Lead starts on it), **Add to PLAN.md** (under an Ideas heading) and **Go deeper** (a new brainstorm on just that idea, next to this one). **Run again** asks a fresh panel. Oracle also offers a brainstorm on its own for open questions like "what could this become?".

## CI and review watcher

With the GitHub CLI signed in (`gh auth login`), the badge next to the branch name shows the open repo's GitHub Actions: **CI passing**, **running** or **failing**, plus how many open PRs are red. It checks every minute (every 20s while something is running) and tells you when a run turns red or goes green again, with a desktop notification when Fleetboard isn't in front.

Click the badge for the CI drawer: the latest run of each workflow on your branch and every open PR's checks. On anything red, **Failed log** shows where it failed, and **Fix it** starts a *CI fixer* console with that log, told to fix the cause (never by weakening a test), run the checks locally and push. A PR on another branch gets its own git worktree, so your checkout isn't touched. Switch on **Fix failures automatically** to have that happen on its own whenever a run turns red.

Review comments are watched too (every two minutes): PR comments, review summaries and inline comments on unresolved threads. When new ones land on a PR an agent made (a team's branch, or one Fleetboard already sent an agent to), they go straight to that agent: its Lead or console if it's still running, otherwise a new *PR #N fixer* console in that branch. The agent is told to address each point, push, and reply on the PR starting with 🤖, so its replies are never sent back to it. Only comments from someone with write access to the repo (GitHub's owner, member or collaborator) are sent on by themselves, plus your own: a routed comment becomes instructions for an agent working in your checkout, and on a public repo anyone can leave one. Everything else — and every comment on a PR no agent of yours made — only notifies you; the drawer has **Send to …** and **Mark handled** for those. A console started with auto-approval is never fed comments automatically, and a *PR #N fixer* console never auto-approves. A CI failure on a PR with an agent on it goes to that agent as well. Bots' plain comments (deploy previews, coverage), bare approvals and resolved threads are left out.

Oracle sees all of this. Ask "what needs me?" or "what should I work on?" and it weighs open questions, red CI, unsent review comments and PRs waiting on you (plus the last morning sweep of your other repos), then offers one-click **Fix CI** / **Send the comments** options.

## Themes

Settings › **Appearance** has six themes: **Ember** (the original warm dark), **Midnight** (cool blue-gray), **Synthwave** (violet, hot pink, neon cyan), **Forest** (pine green, amber), **Graphite** (neutral grays, acid lime) and **Paper** (light). Terminals switch palettes with the theme. Pick any **accent color** to use on top of any theme; text on it turns dark or light to stay readable.

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
