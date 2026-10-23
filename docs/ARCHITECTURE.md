# Fleetboard architecture (contracts for feature modules)

Electron (main + preload) + React 19 renderer built with electron-vite. TypeScript everywhere.
Read `docs/RESEARCH.md` for the feature spec (what each feature must do and look like).

## Layout

```
src/shared/types.ts      data model (BoardNode, Workspace, Project, Settings, MemoryCard, Profile, ...)
src/shared/agents.ts     AGENTS catalog (bin, resumeArgs, yoloArgs, configEnv, headless(prompt))
src/main/                Electron main process
  index.ts               window, core IPC (pty:*, pdf:fromHtml, win:*, app:*), registers modules
  context.ts             MainContext passed to each module's register(ctx)
  roots.ts               which paths the fs handlers, fbfile:// and git may touch: the project, what the
                         user granted, the app's own folders
  platform.ts            Linux/Windows differences in one place: console shell (PowerShell on Windows),
                         PATHEXT lookup, npm .cmd wrappers run as node <script>, kill a process tree,
                         junctions instead of symlinks, forward-slash paths for the renderer.
  pty.ts                 PtyManager: real PTYs (node-pty), raw buffer, answer(), onSpawn/onExit listeners;
                         closing a console ends an agent CLI's whole process group (a shell's like a terminal)
  orphans.ts             the consoles running, on disk: the next launch ends what a run that died left running
  errors.ts              stray main-process errors: logged to ~/.fleetboard/logs/main.log, shown as a toast
                         (the renderer's own go to the same log through app:logError: lib/strayErrors.ts)
  goal.ts                runs a loop's goal command (goal:check) in the project folder, exit code = verdict
  screen.ts              TermScreen: a headless xterm per console, what the terminal actually shows
  status.ts              detectPrompt (menus, hints, y/n on the cursor row), StatusTracker, answerKeys: pure, clock-injected
  hooks.ts               receives Claude Code hook events (per-run secret in FB_HOOK_TOKEN)
  localserver.ts         secrets and request checks shared by the local HTTP servers
  remote.ts              the phone Inbox server (off unless enabled in Settings); remote-page.ts is its page
  run.ts                 the one way a child process is run: run(), gitEnv(), ghEnv(), and git(), which
                         adds --no-ext-diff --no-textconv so a repo's own config cannot run commands
  journal.ts             what happened while nobody was watching: ~/.fleetboard/journal/<date>.jsonl
  permissions.ts         what the app's window and a page in a web tile may ask for
  fleet.ts               Teams: the fleet MCP server (Lead/worker/reviewer tools), worktrees, merges, Ready;
                         every tool call is checked against the caller's role (toolDenial), and a worktree or
                         branch is only removed once nothing uncommitted or unmerged would go with it
  plan.ts                links workers to the Lead's plan tasks (by id, number, title, or a clear match)
  gemini-home.ts         a Gemini CLI home per team console (GEMINI_CLI_HOME): the user's ~/.gemini linked in,
                         settings with the fleet MCP server added (Gemini reads MCP servers only from settings)
  sessions.ts            each console's own conversation: ids for Claude Code / Gemini, found for Codex;
                         resumable / taken / free / lost, as each real CLI behaves
  cli.ts                 headless one-shot runs of the user's CLI (claude -p streaming) — IPC cli:run
  store.ts               persistence (~/.fleetboard) — IPC store:*; refuses to open or overwrite a board whose
                         schema is newer than SCHEMA_VERSION. writeJsonAtomic (paths.ts) fsyncs before the
                         rename, so an atomic write is a durable one
  fsops.ts               dialogs, fs:tree (level by level, within a budget; deeper folders read when opened),
                         fs:write (atomic; with a base, refuses to overwrite a change made on disk meanwhile), shell:*
  agents.ts              agents:detect
  git.ts                 the git drawer: status, diffs, commits, push/pull, branches, PRs (gh)
  ci.ts                  the CI watcher: Actions runs for the branch, open PRs' checks, failed logs and
                         review comments, through gh
  sweep.ts               the morning sweep: a read-only health report across all of the user's repos
  live.ts                live team work without a model: stalls, each worker's uncommitted diff, the
                         charter's done-when run as merged work lands
  knowledge.ts           what a repo's own files say about its checks, owners and style (plain reads)
  skills.ts              Claude Code skills: SKILL.md folders, personal and per project
  starter.ts             first goals for an empty board, read from the repo (a plan, a TODO), never generated
  activity.ts            what a console is doing, from the tool-call bullets its terminal shows
  usage.ts               token usage from the CLIs' own logs, read on from where the last read stopped
  profiles.ts            several sign-ins per CLI (its config dir per profile)
src/shared/prompt.ts     Prompt / PromptAnswer: a question a console is waiting on, and how to answer it
src/shared/approvals.ts  Prompt → Inbox card (title, detail, buttons), for the board and the phone
src/shared/qr.ts, ansi.ts  QR encoder (phone link), stripAnsi for matching words in output streams
src/shared/fleet.ts      team shapes (FleetMember, FleetState, FleetReady); charter.ts the agreed job;
                         mergeReview.ts the Ready card's checks; live.ts and drift.ts work against the charter;
                         knowledge.ts repo knowledge; spend.ts what a worktree cost
src/shared/ci.ts, time.ts, seq.ts, themes.ts  failing CI conclusions, the local day key, walking a list by
                         neighbours, the app themes
src/preload/index.ts     window.fb = { invoke, send, on, pathForFile }
src/renderer/src/
  lib/api.ts             invoke(), on(), errorText(), uid(), runCli(), extractJson(), fileUrl()
  lib/journal.ts         journal(kind, text, detail): a Night-log line for anything done unattended
                         (main/journal.ts writes it)
  workbench/paths.ts     the renderer's path maths: joinPath, dirname, baseName, relativeTo, isInside
  state/store.ts         zustand store useApp (project, workspaces, nodes, groups, wires, ink, panels, toasts, confirm)
  engine/consoles.ts     spawnConsoles(), sendToConsole(), killConsoles(), pauseAll/resumeAll, resolveTargets(), consoleTail(), onConsoleData()
  engine/engines.ts      registerEngine(fn) — background engines started once at boot
  board/                 Board (pan/zoom/marquee/drop), NodeFrame, GroupFrame, Wires, InkLayer, BoardOverlays
  nodes/registry.tsx     NODE_DEFS: node type → component; nodes/*Node.tsx
  panels/registry.tsx    PANELS (modals) and DRAWERS (right floating cards); panels/*Panel.tsx, studios/*Studio.tsx;
                         panels/names.ts lists the names alone (no React), and the registry is checked against it
  fleet/                 the Inbox, the charter gate, team rules, the away summary, the ambient line and the
                         model pass at repo knowledge
  orchestration/         the fleet model the mission map, orchestrator and loops share; board presets
  continuity/            usage and memory: the top-bar pill, the usage drawer, memory cards
  playbooks/             one-click presets for regular work, each starting a Lead with a written brief
  chrome/                TopBar, Rails, BottomBar, Home, Minimap, FocusBar, UsagePill, BranchBadge, CiBadge
  voice/CommandBar.tsx   bottom command bar
  features/<area>.ts     side-effect entry per feature area: registerEngine(), BOARD_OVERLAYS.push()
  ui/Modal.tsx           <Modal>, <Drawer>, <Switch>, <Seg>
  styles/theme.css       design tokens + primitives (.btn .chip .pill .input .seg .switch .menu .md .label ...)
  styles/board.css       board + chrome styles
```

## Rules

- **Main-process modules** export `register(ctx: MainContext)` and use `ctx.ipc.handle('area:verb', ...)`.
  Push events with `ctx.emit(channel, ...args)`. Use `loginEnv()` from `env.ts` for child process env
  (it has the user's PATH), `which(bin)` to resolve binaries.
- **Renderer → main**: `invoke('channel', ...args)`; events: `on('channel', cb)` (returns unsubscribe).
- **Board state** goes through `useApp` actions (`addNode`, `updateNodeData`, `addGroup`, `addWire`, `addInk`, ...).
  Every mutation is persisted automatically (debounced) to `~/.fleetboard/projects/<id>.json`.
  Feature state that is not a board item: `setProjectExtra(key, value)` (per project, e.g. loops, memory)
  or `setWsExtra(key, value)` (per workspace). Global (cross-project) values: `invoke('store:getGlobal', key)` /
  `invoke('store:setGlobal', key, value)`.
- **Selectors**: `useApp(s => ...)` must return stable references (zustand v5). For derived arrays use
  `useShallow` from `zustand/react/shallow`, or select primitives / strings.
- **Nodes** receive `NodeProps` (`node`, `selected`, `zoom`, `maximized`). Interactive content that scrolls
  must carry class `no-board-wheel` (or `scrollable`) so the board does not pan. Inputs work normally; the
  board ignores keyboard shortcuts while focus is in input/textarea/contenteditable/terminal.
  Chromeless nodes (note/text/image) draw everything; start a drag by calling `startNodeDrag(e, node)`
  from `board/NodeFrame.tsx` on their own handle.
- **Panels**: modals render `<Modal title sub icon width footer>`; drawers render `<Drawer title>`.
  Open with `useApp.getState().openPanel(name, props)` / `openDrawer(name, props)`.
- **Headless CLI** (planner, studios, memory scan, handoff summaries, loop judges):
  `runCli({ prompt, cwd: project.path, agentId?, allowTools? }, onChunk)` → `{ promise, cancel }`.
  Default agent is the user's `settings.plannerAgent` (claude). Read-only tools by default.
  Parse JSON replies with `extractJson()`.
- **Consoles**: never spawn PTYs directly; create console nodes with `spawnConsoles({...})` (they start when
  mounted) and type into them with `sendToConsole(id, text, submit)`. `consoleTail(id)` returns plain text.
  Live/status: `useApp(s => s.live[id])`, `useApp(s => s.statuses[id])`
  (`starting | working | idle | needs-you | done | paused | exited`).
- **Confirmations**: anything destructive uses `await useApp.getState().confirm({ title, body, confirm, danger })`.
  Toasts: `useApp.getState().toast(text, tone)`.
- **Style**: dark warm palette, single red-orange accent (`var(--accent)`), Geist UI font, JetBrains Mono for
  code/consoles, Fraunces italic for display headings. Reuse classes in theme.css. Put feature CSS in
  `src/renderer/src/styles/<area>.css` and import it from your feature entry file (`features/<area>.ts`),
  or from the panel itself when its area has no entry file (sweep, studios).
- Do not add npm dependencies **that ship with the app**. Available: react, zustand, lucide-react,
  @xterm/*, marked, highlight.js, @huggingface/transformers, kokoro-js. A devDependency is a smaller
  promise — it is not in anyone's install — but still a promise: oxlint and the build chain are the
  only ones, and a new one needs the same argument as a runtime one.
- **Console state comes from the screen.** Read what a console shows with `ptys.screen(id)` / `pty:prompt`
  and `pty:tail` (rendered text, not the raw stream). Answer a question with `pty:answer` (it re-reads the
  live screen and refuses if the question changed); never type option digits blindly.
- **Local HTTP servers** take a per-run secret (hooks: in the URL, from the console's environment; fleet
  MCP: a bearer token, from a 0600 file for Claude and an env var for Codex, never on a command line) and
  check requests with `refuse()` (no browser Origin, Host must be 127.0.0.1/localhost). A fleet tool call is
  then checked against the caller's **role**: `tools/list` only decides what a member is told about.
- **HTML from a repo, a model or a web page goes through `sanitizeHtml`** (`workbench/markdown.ts`), and a URL
  out of it or out of the board file goes through `safeUrl`. `marked` has no sanitizer of its own, so only that
  module may import it (studios/docs/render.ts goes through renderMarkdown) — `test/unit/html-safety.test.ts`
  enforces both rules.
- Verify with `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:e2e` (see Testing).
  `npm run lint` is oxlint, errors only; its warnings (the React Compiler rules, exhaustive-deps) are
  there to read, not to gate.

## Testing

- `npm test`: unit tests with `node:test` (test/unit). TypeScript is compiled with the same oxc transform
  Vite uses (test/support/register.mjs); `electron` resolves to a recording stub; renderer modules run on a
  fake preload bridge (test/support/renderer-env.ts) where tests answer IPC channels and see every call.
- **Recorded sessions** (test/fixtures/casts): real Claude Code, Codex, Gemini and bash sessions, hook events
  included, recorded with `node test/tools/record.mjs` and replayed through the screen model and status
  tracker. Each mark is named `<expected status>: <what is on screen>`. `node test/tools/replay.mjs file.cast`
  prints the screen at each mark. To cover a new CLI or screen, record it and add marks.
- `npm run test:e2e`: builds the app and drives it under Xvfb over the DevTools protocol (test/e2e/harness.ts),
  each run with its own `FLEETBOARD_HOME`, home folder and PATH. `claude` there is a scripted fake
  (test/fake-agent/claude.mjs): a Claude-like TUI that runs the real hook commands, speaks MCP to the fleet
  server and follows a JSON scenario, so Teams run end to end without tokens. `E2E_SHOTS=dir` saves screenshots.
- test/e2e/real: the same flows with the real CLIs, run by hand. Claude Code: `FLEETBOARD_REAL_CLAUDE_CONFIG`
  points at an onboarded config dir (copied, never changed); these spend tokens. Codex and Gemini CLI:
  `FLEETBOARD_REAL_CODEX` / `FLEETBOARD_REAL_GEMINI` name the binary, which talks to a local mock of its
  model API (test/support/mock-responses.ts), so no account is needed.
- test/unit/agent-flags.test.ts checks every flag passed to Claude Code, Codex and Gemini CLI against the
  installed CLI's `--help` (skipped for a CLI that is not installed; `FLEETBOARD_CLI_PATH` adds places to
  look). CLIs drop flags: run it after upgrading one.
- test/e2e/leaks.test.ts opens and closes panels, consoles and workspaces over and over and checks that
  memory, DOM nodes, listeners and processes do not pile up.
- **Invariant tests** encode rules a reviewer would otherwise have to remember. They read the source, so
  they catch a new call site rather than a new behaviour: `html-safety.test.ts` (only the sanitizing
  modules may import `marked`; every raw-HTML site sits in a file that names a sanitizer; no secret from
  `Math.random`), `argv-safety.test.ts` (every `headless` definition in the AGENTS catalogue wraps its
  prompt in `promptArg`), `fleet-roles.test.ts` (`callTool` consults `toolDenial` before the first tool
  runs). When you add an agent, a panel that renders HTML, or a fleet tool, these are what will fail.
- Races show up under load, so CI runs the suite three files at a time (`FB_E2E_JOBS=3 npm run test:e2e`;
  the default is 1, which is what to use when reproducing a failure). That found a note opening as an
  empty editor, which one at a time never showed. `npm run test:e2e:one -- test/e2e/<file>.test.ts`
  runs a single file against the current build.
- CI (.github/workflows/ci.yml) runs typecheck (twice: `tsconfig.json` and `tsconfig.strict.json`),
  the linter, two `npm audit` passes, unit and end-to-end tests on Linux, and typecheck, unit tests
  and the Windows-specific e2e files on Windows. It runs on a pull request and on a push to master —
  a branch with a pull request open would otherwise run all of it twice. The Windows installer is
  built only for master and tags, since nothing consumes it otherwise and release.yml builds it again
  from scratch on a tag.
- `FB_E2E_HEADLESS=1` skips Xvfb entirely (`--ozone-platform=headless`), which is how to run the e2e
  suite on a machine without it.
