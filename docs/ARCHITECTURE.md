# Fleetboard architecture (contracts for feature modules)

Electron (main + preload) + React 19 renderer built with electron-vite. TypeScript everywhere.
Read `docs/RESEARCH.md` for the feature spec (what each feature must do and look like).

## Layout

```
src/shared/types.ts      data model (BoardNode, Workspace, Project, Settings, MemoryCard, Profile, ...)
src/shared/agents.ts     AGENTS catalog (bin, resumeArgs, yoloArgs, configEnv, headless(prompt))
src/main/                Electron main process
  index.ts               window, core IPC (pty:*, pdf:fromHtml, png:capture, win:*), registers modules
  context.ts             MainContext passed to each module's register(ctx)
  pty.ts                 PtyManager: real PTYs (node-pty), raw buffer, answer(), onSpawn/onExit listeners
  screen.ts              TermScreen: a headless xterm per console, what the terminal actually shows
  status.ts              detectPrompt (menus, hints, y/n on the cursor row), StatusTracker, answerKeys: pure, clock-injected
  hooks.ts               receives Claude Code hook events (per-run secret in FB_HOOK_TOKEN)
  localserver.ts         secrets and request checks shared by the local HTTP servers
  remote.ts              the phone Inbox server (off unless enabled in Settings); remote-page.ts is its page
  cli.ts                 headless one-shot runs of the user's CLI (claude -p streaming) — IPC cli:run
  store.ts               persistence (~/.fleetboard) — IPC store:*
  fsops.ts               dialogs, fs:tree/read/write/..., shell:*
  agents.ts              agents:detect
  git.ts / usage.ts / profiles.ts   feature modules (stubs to fill)
src/shared/prompt.ts     Prompt / PromptAnswer: a question a console is waiting on, and how to answer it
src/shared/approvals.ts  Prompt → Inbox card (title, detail, buttons), for the board and the phone
src/shared/qr.ts, ansi.ts  QR encoder (phone link), stripAnsi for matching words in output streams
src/preload/index.ts     window.fb = { invoke, send, on, pathForFile }
src/renderer/src/
  lib/api.ts             invoke(), on(), uid(), runCli(), extractJson(), fileUrl(), basename()
  state/store.ts         zustand store useApp (project, workspaces, nodes, groups, wires, ink, panels, toasts, confirm)
  engine/consoles.ts     spawnConsoles(), sendToConsole(), killConsoles(), pauseAll/resumeAll, resolveTargets(), consoleTail(), onConsoleData()
  engine/engines.ts      registerEngine(fn) — background engines started once at boot
  board/                 Board (pan/zoom/marquee/drop), NodeFrame, GroupFrame, Wires, InkLayer, BoardOverlays
  nodes/registry.tsx     NODE_DEFS: node type → component; nodes/*Node.tsx
  panels/registry.tsx    PANELS (modals) and DRAWERS (right floating cards); panels/*Panel.tsx, studios/*Studio.tsx
  chrome/                TopBar, Rails, BottomBar, Home, UsagePill (stub), BranchBadge (stub)
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
  `src/renderer/src/styles/<area>.css` and import it from your feature entry file (`features/<area>.ts`).
- Do not add npm dependencies. Available: react, zustand, lucide-react, @xterm/*, marked, highlight.js,
  nanoid, @huggingface/transformers, kokoro-js.
- **Console state comes from the screen.** Read what a console shows with `ptys.screen(id)` / `pty:prompt`
  and `pty:tail` (rendered text, not the raw stream). Answer a question with `pty:answer` (it re-reads the
  live screen and refuses if the question changed); never type option digits blindly.
- **Local HTTP servers** take a per-run secret (hooks: in the URL, from the console's environment; fleet
  MCP: a bearer token, from a 0600 file for Claude and an env var for Codex, never on a command line) and
  check requests with `refuse()` (no browser Origin, Host must be 127.0.0.1/localhost). HTML from repos or models goes through `sanitizeHtml`.
- Verify with `npx tsc --noEmit -p tsconfig.json`, `npm test` and `npm run test:e2e` (see Testing).

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
- test/e2e/real: the same flows with the real Claude Code, skipped unless `FLEETBOARD_REAL_CLAUDE_CONFIG`
  points at an onboarded config dir (copied, never changed). They spend tokens; run them by hand.
- CI (.github/workflows/ci.yml) runs typecheck, unit and end-to-end tests on every push.
