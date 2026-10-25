# Fleetboard — Principal Engineering Audit

**Date:** 2026-10-25 · **Revision audited:** `83d247d` (master) · **Scope:** the whole repository (`src/`, `test/`, `scripts/`, `bin/`, CI, docs)
**Method:** I read the implementation and traced call paths. Three specialist reviews ran in parallel, on teams/git/agent security, on persistence/process lifecycle, and on the renderer. I re-checked every High finding against the source myself. No application code was changed; this file is the only addition.

> **How to read the evidence.** `file:line` references were taken from the source at the revision above.
> "Verified" means I traced the path in the code myself.
> "Reported" means a specialist review traced it and I checked the cited lines but not every branch.
> Nothing here was proven by running an exploit.

---

## 1. Executive Summary

Fleetboard is a local Electron desktop app. It shows an infinite canvas of real PTY terminals running AI coding-agent CLIs (Claude Code, Codex, Gemini and about 32 others). It adds orchestration on top:
- multi-agent "teams" in git worktrees, coordinated through a local MCP server;
- an approval Inbox, including a phone version;
- voice control with on-device speech models;
- CI and review watchers, loops, studios, usage analytics.

It is about 42k lines of TypeScript, written by one human contributor with heavy AI assistance (281 commits).

**Overall condition: good, and better than its size and "personal project" label suggest.** This codebase has clearly been through several rounds of adversarial review. The Electron security baseline is solid: sandboxed renderer, context isolation, a narrow preload, an allowlisted IPC surface that checks the sender frame, strict CSP, allowlist HTML sanitization, and permission handlers on both sessions. The local HTTP servers authenticate correctly and resist DNS rebinding. Writes are durable (fsync plus atomic rename), and corrupt state is recovered rather than overwritten. Its "invariant tests" encode security rules as tests. Few codebases of this size get those things right.

**Its most serious weakness is the trust model for agent-to-agent and agent-to-user automation.** The machinery that saves the user clicks can be steered by content a worker agent controls:
- the post-merge "done-when" check runs automatically, outside any sandbox;
- "Allow for the team" matches the text of a command, not what the command does;
- the deny list for those rules is regex-based and easy to get around.

None of these breaks the Electron boundary. Each of them weakens the human-in-the-loop guarantee the product is built around, and a prompt-injected agent (from a malicious repo, issue or dependency) is a realistic adversary for this kind of tool.

**Secondary risks:**
- **Process lifecycle races:** a console can be spawned twice. A failure during startup leaves an invisible process holding the single-instance lock.
- **Main-thread work:** synchronous fsync on every board save and on the usage cache, competing with terminal output on the same thread.
- **Renderer re-renders:** the camera sits in persisted project state, so every pan frame re-renders the whole app and schedules a save.
- **Maintainability debt:** a 1,573-line `fleet.ts`, a zustand store imported by 106 of 165 renderer files, and about 85% of IPC still untyped.
- **Bus factor of one.**

**Headline numbers:**
- Overall score: **6.9 / 10**.
- 0 Critical findings, 6 High, 15 Medium, and a set of Low.
- `npm audit`: 0 known vulnerabilities, production and full.
- Unit tests: 68 of 103 files could run in this environment, and all passed (490 cases, 34 skips, 0 assertion failures). The other 35 could not load without `node_modules`, which I was not permitted to install.

---

## 2. System Overview

### 2.1 Technology stack (confirmed from `package.json`, configs)
| Layer | Technology |
|---|---|
| Shell | Electron ^44.9.3, electron-vite 6, electron-builder 26 (NSIS for Windows, AppImage for Linux) |
| Language | TypeScript ^7 (`strict`); a second pass with `noUncheckedIndexedAccess` over `src/` (`tsconfig.strict.json`) |
| UI | React 19, zustand 5, xterm.js 6, lucide-react, marked + highlight.js (sanitized) |
| Native | node-pty (PTYs; ConPTY on Windows) |
| ML | @huggingface/transformers (Whisper STT), kokoro-js (TTS), in Web Workers, WebGPU/wasm |
| Lint/test | oxlint (correctness = error); `node:test` with an oxc transform loader; a CDP-driven e2e harness under Xvfb |
| CI | GitHub Actions: Ubuntu (typecheck ×2, lint, unit, audit ×2, e2e with 3 jobs) and Windows (typecheck, unit, Windows e2e, installer on master); a tag-driven release |

### 2.2 Process architecture
```
┌──────────────── Electron main (Node) ─────────────────────────────────────────┐
│ index.ts: window, core IPC, protocol fbfile://, permission handlers           │
│ ipc.ts guardedIpc: sender === win.webContents && senderFrame === mainFrame    │
│              + validateIpc (shared/ipc.ts allowlist + shape checks)           │
│ PtyManager (pty.ts) ── node-pty ── agent CLIs / shells                        │
│   └ TermScreen (headless xterm) → status.ts detectPrompt → Inbox prompts      │
│ hooks.ts      127.0.0.1 HTTP: Claude Code hook events (HMAC per console)      │
│ fleet.ts      127.0.0.1 HTTP: MCP JSON-RPC for teams (bearer per member)      │
│ remote.ts     Tailscale/LAN/loopback HTTP: phone Inbox (bearer in #fragment)  │
│ store.ts      ~/.fleetboard JSON (atomic+fsync, snapshots, corrupt recovery)  │
│ git.ts/ci.ts/sweep.ts  git & gh via execFile with hardened flags (run.ts)     │
│ cli.ts/goal.ts headless `claude -p` runs; shell goal checks                   │
└───────────────────────────────────────────────────────────────────────────────┘
          ▲ contextBridge window.fb {invoke, send, on, pathForFile}
┌─────────┴──────── Renderer (sandboxed, CSP) ───────────────────────────────────┐
│ zustand useApp (state/store.ts) → debounced store:saveProject                  │
│ board/ nodes/ panels/ studios/ (React)  ·  engine/ (consoles, loops, fleet)    │
│ voice/ (STT/TTS workers, planner → `claude -p`, actions)  ·  fleet/ Inbox      │
│ <webview partition="persist:fleetboard-web"> web tiles (no preload, sandbox)   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Primary workflows (traced)
1. **Console lifecycle.**
   - A console node mounts and calls `pty:spawn` (`ConsoleNode.tsx` → `pty.ts:90`).
   - The env comes from a login shell (`env.ts:14`).
   - Output flows `pty:data` → xterm, and also into the headless `TermScreen`, which is used for status and prompt detection.
2. **Approvals.**
   - `detectPrompt` reads the rendered screen and the Inbox card shows the options.
   - `pty:answer` re-reads the screen and refuses if the card's `seen` fingerprint changed (`pty.ts:463-485`).
3. **Teams.**
   - A goal starts a Lead (`fleet:startLead`).
   - The Lead calls MCP tools: plan, spawn workers in worktrees, merge, finish.
   - A Ready card appears, and Merge brings the work into the user's checkout.
4. **Persistence.**
   - Every store mutation triggers a debounced save 350 ms later.
   - Main writes it atomically, takes a 5-minute snapshot, and recovers from corrupt files.
5. **Phone Inbox.** Opt-in; an HTTP server bound to one interface, with a bearer secret.

### 2.4 External integrations
- Agent CLIs on PATH; GitHub through `gh` (CI, PRs, review comments, release check).
- Hugging Face model downloads (one-time).
- Tailscale/LAN for the phone; arbitrary web pages in web tiles.

### 2.5 Maturity classification
**A late-stage MVP / early production desktop tool for a single power user.** It has release automation, a recovery UI, accessibility work, benchmarks and a hardening log (`docs/HARDENING.md`). It does not have:
- code signing;
- Electron fuses;
- auto-update;
- macOS support;
- telemetry or crash reporting;
- multiple maintainers.

---

## 3. Engineering Scorecard

| Category | Score | Evidence |
|---|---:|---|
| **Architecture** | 7 | **Strengths:** a clear main/preload/renderer split; one `register(ctx)` pattern per main module (`index.ts:337`); shared pure modules (`src/shared`) reused by main, renderer and the phone page. **Weaknesses:** `fleet.ts` (1,573 lines) mixes the MCP server, the worktree manager, merge logic and role policy; the renderer store is a god object (106/165 files import it); 4 import cycles. |
| **Code Quality** | 7 | **Strengths:** consistent, defensive, deeply commented; 0 `@ts-ignore`; ~167 `any` in 42k LOC; strict TS plus a `noUncheckedIndexedAccess` pass. **Weaknesses:** three diverging console-name resolvers; repeated "is typing" checks; some very long functions; comments are narrative and long, which raises the cost of keeping them accurate. |
| **Security** | 6.5 | **Strengths:** Electron baseline is excellent (see §1); local servers check Origin, Host and secrets with constant-time compares; git hardening; `promptArg` argv safety; PR-comment author trust. **Weaknesses:** agent-automation trust gaps (H-1, H-2, H-3); path-confinement gaps (M-1, M-2); MCP tokens on disk (M-6); LAN mode is plaintext (documented). |
| **Performance** | 6 | **Strengths:** offscreen `content-visibility`; a NodeFrame memo for terminals; level-by-level `fs:tree` within a budget; incremental usage reads; a benchmark exists (p95 51–95 ms at 20–50 terminals on a 2015 i5). **Weaknesses:** sync fsync on the main thread per save; the camera in persisted state re-renders the app on every pan frame; the usage cache grows without bound and is rewritten every minute. |
| **Reliability** | 7 | **Strengths:** durable writes; corrupt-file set-aside and snapshot restore; schema "too new" refusal; single-instance lock; orphan cleanup with start-time checks; quit-save handshake with a watchdog. **Weaknesses:** startup failure leaves a headless zombie (H-5); double spawn (H-4); close with a dead renderer (M-9); Windows pause race (M-12). |
| **Maintainability** | 6 | **Strengths:** strong conventions in `ARCHITECTURE.md`; invariant tests. **Weaknesses:** a single maintainer; large modules; most IPC untyped (24/115 channels typed; 156 untyped call sites vs 32 typed); untyped `extras: Record<string, any>` holds 12 feature keys; documentation drift (L-1). |
| **Testing** | 8 | 103 unit files and 30 e2e files (145 e2e cases) with a scripted fake Claude that speaks MCP and runs real hooks; recorded real-CLI casts; real-CLI suites; leak, crash, CSP and sanitizer tests; flag-drift tests against installed CLIs. **Gaps:** no coverage measurement; renderer unit reach is about 41/165 files; the done-when, team-rule and voice-confirm paths found here are not covered adversarially. |
| **Developer Experience** | 7 | One-command dev, build and launch; clear test switches; Docker parity for Windows developers; `ARCHITECTURE.md` is unusually useful. **Weaknesses:** no `engines` or `.nvmrc`; heavy postinstall (Electron download plus a node-pty rebuild); docs drift; no coverage or formatting gate. |
| **Production Readiness** | 6 | Release pipeline with tag-on-master checks and immutable releases; recovery UI. **Missing:** code signing (SmartScreen warnings), Electron fuses, crash reporting, auto-update, macOS; the agent-trust items above. |
| **Overall** | **6.9** | A weighted judgment, not an average. Security, reliability and testing count most for a tool that runs autonomous code-writing agents on a developer's machine. |

**What could not be verified:** full typecheck, lint, build and e2e (no `node_modules`); Windows behavior; real-CLI behavior; runtime performance under load; whether Codex's sandbox blocks loopback.

---

## 4. Critical Findings

**None.** I found nothing that, on its own, gives a remote attacker code execution, silently corrupts or loses committed data, or breaks a core function for every user. The High findings below are the nearest to Critical, because they weaken the human approval gate against a prompt-injected agent.

---

## 5. High-Priority Findings

### H-1 · The post-merge "done-when" check runs worker-controlled code automatically, outside any sandbox
- **Severity:** High · **Category:** Security / trust boundary · **Confidence:** High (verified)
- **Description:** After every `fleet_merge`, Fleetboard runs the charter's done-when command in the integration worktree on its own, and again on a 5-minute tick whenever HEAD moves. It runs through the user's login shell, with the user's full environment, unsandboxed.
- **Evidence:**
  - `src/main/fleet.ts:1019` calls `void runCheck(s, 'merge')`.
  - `src/main/live.ts:206-208`, `checkTick()`, runs `runCheck(s, 'tick')` for every team.
  - `src/main/goal.ts:44-51` runs `loginEnv()` and then `spawn(oneShot(command, env))`.
  - Workers, by contrast: Claude workers get only `--permission-mode acceptEdits` (`fleet.ts:352`), so their *commands* still need approval. Codex workers run with `--sandbox workspace-write` (`shared/agents.ts:41`).
- **Root cause:** "Done when `npm test` passes" is treated as the user's own command. What `npm test` actually runs is defined by files the workers just edited: `package.json` scripts, test files, config.
- **Impact:** A prompt-injected worker that edits `package.json`'s `test` script gets arbitrary code run with network access and the user's credentials. That is exactly the action the approval model refused it. It happens before the user sees the Ready card.
- **Likelihood:** Medium. It needs a prompt injection (a hostile issue, README or dependency), which is a well-documented attack on agentic tools.
- **Remediation:**
  1. Run only the `start` baseline automatically; make post-merge and tick checks user-initiated (`fleet:verifyReady` already exists).
  2. Or keep them automatic but pause when merged changes touch files that define commands: `package.json`, lockfiles, `Makefile`, `*.config.*`, test setup.
  3. Longer term, run checks with a scrubbed env and no network (bubblewrap/firejail on Linux; a restricted token on Windows).
- **Effort:** S for options 1 and 2; L for the sandbox.

### H-2 · "Allow for the team" rules approve a command's text, not what it does
- **Severity:** High · **Category:** Security / authorization · **Confidence:** High (verified)
- **Description:** Once the user allows `npm test` for a team, any member's later `npm test` prompt is answered automatically for as long as the team exists. Members can freely edit the files that define what `npm test` does.
- **Evidence:**
  - `src/renderer/src/fleet/teamRules.ts:10-13` describes the design (exact string match).
  - `src/main/index.ts:215-220`: `pty:answerByRule` re-checks only that the prompt still shows that string.
  - `fleet.ts:352`: workers edit with `acceptEdits`.
- **Root cause:** Same as H-1. The command string is used as a proxy for its behavior.
- **Impact:** A single click turns into standing approval for arbitrary code, once a worker rewrites the script.
- **Remediation:**
  - Bind each rule to a content hash of the files that define the command (package.json `scripts`, Makefile targets), taken in the *asking member's* worktree. Drop the rule when the hash changes.
  - Show "the script changed since you allowed it" on the next card.
- **Effort:** M.

### H-3 · The team-rule deny list is regex-based and easy to get around
- **Severity:** High (because it compounds H-2) · **Category:** Security / input validation · **Confidence:** High (verified)
- **Evidence:**
  - `src/shared/approvals.ts:165`: the pattern `\brm\s+-[a-z]*r` misses `rm -f -r x`, `rm --recursive x` and `find . -delete`.
  - `approvals.ts:166`: `\bgit\s+push\b` misses `git -C . push`.
  - `approvals.ts:183`: the network deny list misses `node -e "fetch(…)"`, `python3 -c`, `npx <pkg>` and `npm install`. Installs are only labelled at `:169` ("Installs packages"), never denied, yet install scripts run arbitrary code and use the network.
- **Root cause:** It tries to enumerate what is dangerous, which can never be complete for a shell.
- **Remediation:** Turn it into an allowlist. Team rules may only be offered for commands whose note is "Runs your tests", "Runs a check or build" or "Only reads", and only with no shell metacharacters, which `:168` already detects. Everything else needs per-prompt approval. Combine this with H-2.
- **Effort:** S.

### H-4 · `pty.spawn` can start two processes for the same console id
- **Severity:** High (it leaves agents running untracked) · **Category:** Concurrency / resource leak · **Confidence:** Medium-High (verified)
- **Evidence:**
  - `src/main/pty.ts:91-92` checks `sessions.get(req.id)`. It then awaits `loginEnv()` (`:98`) and `which()` (`:115`), and only registers the session at `:189`.
  - `env.ts:14-15` caches the result but does not share an in-flight promise.
  - The exit handler at `pty.ts:220` deletes the session only if it is still the same one, but `:223` emits `pty:exit` for the id regardless.
  - On the renderer side, `ConsoleNode` re-requests a launch if it remounts before the spawn resolves (a workspace switch during auto-resume, or a team console added before main spawns it).
- **Impact:**
  - Two CLIs resume the same session id and write to one conversation.
  - The first process is untracked: `dispose()` walks only `sessions`, and the `RunRecord` entry is overwritten. It outlives the app and keeps spending tokens.
  - When it eventually exits, the live console is marked exited.
- **Remediation:**
  - Keep an `inflight: Map<id, Promise<PtyInfo>>` and return the pending promise.
  - Share the in-flight `loginEnv` promise.
  - Emit `pty:exit` only when `sessions.get(id) === s` or nothing has replaced it.
- **Effort:** S.

### H-5 · An exception during startup leaves a windowless process holding the single-instance lock
- **Severity:** High (impact) / likelihood Low · **Category:** Reliability · **Confidence:** High on the mechanism (verified)
- **Evidence:**
  - `src/main/index.ts:299-342`: every `register()`, `fleet.register` and `remote.register` runs in an unguarded `whenReady().then(async…)`. `createWindow()` is last, at `:341`.
  - `index.ts:290-291`: `second-instance` returns early when `!win`.
  - A concrete trigger: `fleet.ts:83-90` `loadAll()` (called at `:1265`) runs `Object.values(s.members)` on any JSON file in `~/.fleetboard/fleet/`. A file without `members` throws.
- **Impact:** One malformed state file means every launch "does nothing". The user has to find and kill a hidden process, and nothing explains why.
- **Remediation:**
  - Wrap each module's `register` in try/catch with `logError`, and always reach `createWindow()`.
  - Show a `dialog.showErrorBox` when startup is degraded.
  - Validate fleet state files the way `validProject` validates boards.
- **Effort:** S.

### H-6 · Voice "confirm" re-resolves targets when it runs, so it can kill consoles that were never named
- **Severity:** High (it destroys running agent work) · **Category:** Correctness / UX safety · **Confidence:** High (verified)
- **Evidence:**
  - `src/renderer/src/voice/planner.ts:571-577`: `livePending()` checks only the project id and a 60 s age.
  - `src/renderer/src/voice/actions.ts:474-478`: `kill` calls `resolveRefs(a.targets, 'workspace')` again at confirm time, then `killConsoles(ids, { confirm: false })`.
  - `actions.ts:150`: "all" resolves to the *currently* active workspace.
- **Scenario:** "close all" → "about to close A, B, C, D" → the user switches workspace → "confirm" closes a different set of running agents, with no further prompt.
- **Remediation:** Resolve ids when the plan is parked. Store `{ids, workspaceId}` and execute exactly those. Drop the plan if the workspace or selection changed. **Effort:** S.

---

## 6. Medium-Priority Findings

| ID | Category | Title | Evidence | Impact | Remediation | Effort | Conf. |
|---|---|---|---|---|---|---|---|
| **M-1** | Security | **Relative paths are authorized against the project but used against the process cwd** | `roots.ts:170-175` resolves a relative path against `projectRoot()` for the check. `fsops.ts:175-194`, `writeText` (`:93-113`) and `paths.ts` `readRegularFile` then use the original relative string, which Node resolves against `process.cwd()`. (Verified.) | A board-supplied relative path (`.ssh/id_rsa`) passes the check as `<project>/.ssh/id_rsa` but is read or written at `<cwd>/.ssh/id_rsa`. On Linux `bin/fleetboard` sets cwd to the app folder; a packaged app's cwd varies (often `$HOME` from a desktop launcher). This undermines the stated purpose of `roots.ts`. | Make `allowed()` return the resolved absolute path and use only that for the operation (check equals use). Add a test with a relative path and a different cwd. | S | High |
| **M-2** | Security | **`git:diff` untracked reads any file; `git:show` skips folder validation** | `git.ts:228-243`: `path.resolve(root, file)` has no containment check, so `file="../../.ssh/id_rsa"` returns up to 400 KB. `git.ts:265-267`: `show()` never calls `validCwd`. (Verified.) | It bypasses fs confinement through a second channel. | Require `within(abs, root)`; call `validCwd` in `show`. | S | High |
| **M-3** | Security | **Fleet IPC handlers trust a `projectPath` from the renderer and can repoint an existing team** | `fleet.ts:1304-1310`, `:541-561`; `state()` overwrites `s.projectPath` (`fleet.ts:99`). `goal:check` does gate this (`goal.ts:85`). (Reported.) | It changes where `mergeReady` merges and which repo worktrees are removed from. | Call `allowed()`, and make `projectPath` immutable once a team exists. | S | High |
| **M-4** | Data loss | **"Done" on a 0-commit Ready card force-deletes branches committed after it** | `fleet.ts:1384` chooses `'force'` from `s.ready.commits`, which is counted at `fleet_finish` time (`:1070`); `removeWorktree` runs `branch -D` (`:278`). (Verified at `:1384`.) | Follow-up work a Lead did after its first finish is deleted. Only uncommitted work is rescued. | Recompute `rev-list --count base..branch` (or `containedIn`) at Done; use `-d` or keep the branch when it is non-zero. | S | High |
| **M-5** | Correctness | **A spoken Inbox answer goes to whatever card is in front when transcription ends** | `planner.ts:665-672` has no `settled()` or same-card check; the keyboard path does guard (`CommandBar.tsx:252,290`). (Reported.) | "Yes" for approval A can approve B. Main's `seen` check confirms the card is consistent, not that it is the card the user meant. | Capture the front card's key at `beginListening`, and act only if it is still in front. | S | Med-High |
| **M-6** | Security | **MCP member tokens are stored on disk at predictable paths** | `fleet.ts:349` writes `mcp-<id>.json` (bearer token, 0600); Gemini tokens are in `gemini-homes/<id>/.gemini/settings.json`. (Verified at `:349`.) | Any member that can read files (a Codex workspace-write sandbox reads the whole disk) can act as the Lead, which defeats `toolDenial`. Role checks are defense-in-depth, not isolation. | Prefer env-expanded headers (`${FB_MCP_TOKEN}`) where the CLI supports them; document the limit. | M | Medium |
| **M-7** | Correctness | **Fleet state from the previous project can render in the new project's Inbox** | `engine/fleet.ts:152-155` does not re-check the project after its await; `inboxModel.ts:367` does not compare `fleet.projectId`. (Reported.) | Merge or discard buttons pair project B's id with project A's data. | Re-check the id after the await; ignore mismatched state in `build()`. Validate in main too. | S | Med |
| **M-8** | Correctness | **Handoff reads a stale store snapshot after a long CLI await** | `engine/handoff.ts:95,100,104`. (Reported.) | The receiver spawns in the wrong workspace, or into an id that doesn't exist, so the board renders empty. | Re-read `useApp.getState()` after the await; abort if the project changed. | S | Med-High |
| **M-9** | Reliability | **The window can't close while consoles exist if the renderer is dead** | `index.ts:155-158` sends `app:confirmQuit` and returns with no watchdog (the no-console path has one, `:164-169`); after more than 3 crashes the page is not reloaded (`:139-147`). (Verified.) | After the "keeps crashing" dialog tells the user to restart, the window can't be closed. | Use the same watchdog, or quit directly when `webContents.isCrashed()`. | S | High |
| **M-10** | Performance | **Every board save blocks the main thread with re-read, pretty-print and 4 fsyncs** | `main/store.ts:212-249` (the `schemaOf` re-read, the board write, an unconditional `saveApp`); `paths.ts:52-79`. (Reported; consistent with code I read.) | Main also carries every terminal's output. Large boards or slow and antivirus-scanned disks cause visible stalls after each pause in typing. | Cache the on-disk schema; write `app.json` only on change; compact JSON; consider moving writes to a worker. | S | High |
| **M-11** | Performance | **The camera is persisted project state: each pan or zoom frame re-renders the app and queues a save** | `state/store.ts:571` (`setCamera` → `mutateWs`); `App.tsx:28`, `Board.tsx:39` select all of `s.project`; memoized `Wires`/`InkLayer` receive `ws` (`Board.tsx:395,404`). (Reported.) | Frame-time cost grows with chrome and drawer complexity. This partly explains the benchmark's 918 ms worst frame. | Keep the camera in a separate non-persisted slice (persist on idle); select primitives in App; pass `ws.wires` and `ws.ink`. | M | High |
| **M-12** | Reliability (Win) | **Pause/resume on Windows is fire-and-forget and can leave a tree frozen while the UI says it is running** | `suspend.ts:217-227` starts PowerShell without awaiting it; `pty.ts:316-330` flips `paused` immediately. (Reported.) | Quickly toggling leaves an agent permanently suspended while it appears to be working. | Serialize per pid; update state only on completion. | S | High |
| **M-13** | Reliability (Win) | **The suspend tree walk trusts `ParentProcessId`, which Windows does not clear** | `suspend.ts:176-189`. (Reported.) | It can suspend unrelated processes of the same user. | Accept a child only if `CreationDate` ≥ the parent's. | S | Med |
| **M-14** | Performance / memory | **The usage cache keeps every event for all time and is rewritten and re-sorted every minute** | `usage.ts:115-125`, `:544-560`, `:783-787`. (Reported.) | Main-thread stalls and memory that grows with history. | A rolling 7-day index; memoize `eventsOf` by `lastScan`; write less often. | M | High |
| **M-15** | Maintainability | **IPC is mostly stringly-typed** | `shared/ipc-contract.ts` types 24 of 115 invoke channels; 156 `invoke<T=any>` call sites vs 32 `request()`. (Verified.) | Contract drift between main and renderer shows up only at runtime; refactors are risky. | Generate the contract from the handler registrations, or require new channels in `IpcContract`; migrate the high-traffic channels (fs, git, fleet) first. | M | High |

### Other Medium-adjacent notes (Low-Medium)
- **Helm suggestions skip planner gates.** `voice/helm/helm.ts:406` passes `fromPlanner=false`, skipping the "adds a step you didn't ask for" check, even though Helm's context includes untrusted console output (`helm/context.ts:322`). The confirm dialog shows only the first message (`helm.ts:356`). Treat Helm output as planner output.
- **Voice "delete group" removes every tile in a group** with no confirm, no unsaved-editor check and no Undo, unless a live console is in it (`actions.ts:353-355`, `:512`). Route it through `board/deleteSelection.ts`.
- **The whole state directory is in the fs allowlist** (`roots.ts:189`), including `profiles/` (CLI credential dirs), `remote.json` (the phone secret) and `app.json`, which holds the persisted `fsGrants`. `mainOwnedGlobal` blocks `store:setGlobal('fsGrants')`, but `fs:write` to `~/.fleetboard/app.json` reaches the same data after a restart. Exclude `profiles/`, `hooks/`, `fleet/`, `remote.json` and `app.json` from the generic fs handlers.

---

## 7. Low-Priority Improvements

| ID | Title | Evidence | Recommendation |
|---|---|---|---|
| L-1 | **Documentation drift** | `README.md:45` says the repo is private; `README.md:60` says Windows CI uses a self-hosted runner. `ci.yml` and `release.yml` say the repo is public and hosted (commits `151c88b`, `83d247d`). README says "26 of the 28 e2e files"; there are 30. | Fix the README; add a docs-review step to the release checklist. |
| L-2 | `pdf:fromHtml` leaks a hidden window on failure | `index.ts:261-266` has no try/finally around `loadURL`/`printToPDF`. HTML is passed as a `data:` URL; Chromium caps URLs at about 2 MiB, so large exports (non-ASCII text triples in `encodeURIComponent`) will probably fail and leak (Medium confidence). | try/finally `w.destroy()`; load from a temp file in `dirs.exports`; write asynchronously. |
| L-3 | No Electron fuses | `electron-builder.yml` has none. | Disable `RunAsNode` and `EnableNodeOptionsEnvironmentVariable`; enable `OnlyLoadAppFromAsar` and asar integrity. |
| L-4 | Unsigned Windows installer, no checksums or provenance | `release.yml`; README tells users to click through SmartScreen. | Authenticode signing (Azure Trusted Signing is low-cost); publish SHA-256s; `actions/attest-build-provenance`. |
| L-5 | Actions pinned to tags, not SHAs | `dependabot.yml:445-447` admits it. | Pin to SHAs; Dependabot keeps them current. |
| L-6 | LAN phone mode is plaintext with a long-lived bearer | `remote.ts:17-21` (documented); the token only rotates on network change or Off. | A time-limited token when on LAN, or a self-signed TLS cert pinned via the QR code. |
| L-7 | The fleet MCP server has `headersTimeout`/`requestTimeout = 0` | `fleet.ts:1187-1189` (intentional for long-poll `fleet_wait`). Also: per-chunk string decoding (`:1163`); a `null` JSON body throws at `handleRpc` `msg.id` (`fleet.ts:1107`) and the request never gets a reply. | A `headersTimeout` before auth; `Buffer.concat` then decode; guard non-object bodies. |
| L-8 | Members whose CLI is missing stay "working" forever | `pty.ts:117` throws; `fleet.ts:587,917` register the member first. | Catch, mark the member failed, release the slot and the worktree. |
| L-9 | No timeout on headless `cli:run` | `cli.ts:61-133`. | Configurable ceiling (e.g. 15 min), cancelled on project close. |
| L-10 | cmd.exe fallback expands `%VAR%` in prompts (Windows) | `platform.ts:105-111,127-128`. | Escape `%` as `%%`, or refuse the cmd fallback for prompt args. |
| L-11 | git hardening misses `core.alternateRefsCommand` and submodule configs; git spawned by `gh` gets no `GIT_OPTS` | `run.ts:108`. | Also set them through `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` in `gitEnv`/`ghEnv`. |
| L-12 | `canWrite` (collaborator check) cached for 1 h | `ci.ts:286`. | 5–10 min. |
| L-13 | Unmigrated or non-ideal persistence details | Journal rotation can overwrite `.1` on a second rotation in a day, and `read()` ignores `.1` (`journal.ts:177,240`); no daily snapshot tier (only 30 × 5 min ≈ 2.5 h); `forgetProject` leaves history; `*.corrupt-*`/`*.tmp` are never pruned; a transient read error on `app.json` silently disables settings saves for the session (`store.ts:102-110,125`). | Small fixes each; a daily snapshot tier is the most valuable. |
| L-14 | Renderer error log has no rate limit | `strayErrors.ts` → `errors.ts` 1 MB rotation; a per-frame error rotates out the first (causal) one. | Dedupe by message, with counts. |
| L-15 | PTY buffer trim copies 400 KB per chunk once full, and can cut an escape sequence | `pty.ts:207-209`. | A ring of chunks; trim on line boundaries. |
| L-16 | Webview partition and src not enforced by main | `index.ts:41-48` strips the preload and forces the sandbox but does not assert `params.partition === WEB_PARTITION`. | Assert it (defense-in-depth: the default session grants mic and clipboard-read). |
| L-17 | CSP could be tighter | `src/renderer/index.html` has no `object-src 'none'`, `base-uri 'none'` or `form-action 'none'`; `connect-src https:` and `img-src https:` are wide. The sanitizer allows `class`/`id` (UI spoofing, id clobbering). | Add those directives; prefix or strip `id`s; allowlist `class` values. |
| L-18 | Small renderer leaks and races | STT model switch strands pending promises (`voice/stt.ts:66-70`); possible duplicated output on terminal re-attach (`ConsoleNode.tsx:64,68`); engines have no teardown (HMR duplicates intervals); `extractJson` is O(n·k) (`lib/api.ts:60`). | Fix opportunistically. |
| L-19 | No `engines` field or `.nvmrc`; CI uses Node 22 | `package.json`. | Declare it. |
| L-20 | Duplicated logic | Three console-name resolvers with different normalization and different meanings of "all" (`actions.ts:52`, `orchestrator.ts:9`, `consoles.ts:196`); three "is typing" checks. | Consolidate into one tested module each. |

---

## 8. Top 10 Highest-Leverage Improvements

| # | Change | Why it ranks here | Effort |
|---|---|---|---|
| 1 | **Turn team rules into an allowlist and bind them to script-file hashes (H-2, H-3)** | It closes the widest remaining gap in the human-approval gate. | S–M |
| 2 | **Stop auto-running done-when checks after merges or ticks, or pause them on script/config changes (H-1)** | It removes unsandboxed execution of worker-authored code. | S |
| 3 | **Make the fs/git confinement check equal the use: one `resolveAllowed()` returning the absolute path; fix `git:diff`/`git:show`; exclude secrets in the state dir (M-1, M-2, §6 note)** | One helper fixes three bypasses and prevents new ones. Add an invariant test like `html-safety`. | S |
| 4 | **Single-flight `pty.spawn` and `loginEnv` (H-4)** | It prevents untracked token-spending processes and corrupted sessions. | S |
| 5 | **Resilient startup: guard each `register`, always open a window, validate fleet state files (H-5)** | It turns a "dead app" support case into a visible, recoverable one. | S |
| 6 | **Freeze the targets of destructive voice actions when they are parked; same-card guard for spoken answers (H-6, M-5)** | Voice is the least explicit input channel, and the one where destructive actions most need fixed targets. | S |
| 7 | **Split the camera out of persisted state; slim App/Board selectors (M-11)** | The largest renderer performance win, and it removes a save per pan. | M |
| 8 | **Take board/usage persistence off the hot path (M-10, M-14)** | Keeps terminal output smooth on slow disks and for long-time users. | S–M |
| 9 | **Split `fleet.ts` into `mcp-server`, `worktrees`, `merge`, `roles` and `state` modules** | The highest-risk, highest-churn file; the split also makes H-1, M-3 and M-4 easier to test. | L |
| 10 | **Sign the installer, enable fuses, publish checksums (L-3, L-4)** | The cheapest move toward distributing to anyone but the author. | M |

---

## 9. Technical Debt Inventory

| Debt | Urgency | Notes |
|---|---|---|
| Agent-trust heuristics (regex command classification, text-equality rules) | **Urgent** | Security-relevant; compounds as more automation (loops, auto-fix CI, phone approvals) builds on the same assumptions. |
| `fleet.ts` monolith (1,573 lines) | **High** | It holds the riskiest logic (merges, branch deletion, roles); every new team feature lands here. |
| Untyped IPC (91 of 115 channels) | **High** | Grows with every feature; the typed path exists, but there is no rule that new channels must use it. |
| Renderer god-store and `extras: Record<string, any>` (12 keys) | Medium | Typed slices per feature, or typed `extras` keys via declaration merging. |
| Screen-scraping prompt detection for third-party TUIs | **Tolerable, but monitor** | It is inherent to the product, and well mitigated by recorded casts, `seen` anchoring and flag-drift tests. It is a single point of fragility whenever a CLI changes its UI. Keep recording casts on every CLI upgrade. |
| Heavy narrative comments | Tolerable | High intent value; the drift risk is shown by L-1. Keep them, but prefer tests over prose for invariants. |
| Synchronous fs in main | Medium | A deliberate tradeoff (ordering, simplicity). Acceptable for small files; not for boards or the usage cache. |
| No coverage measurement | Medium | `node --test --experimental-test-coverage` costs nothing to add. |
| Windows path via PowerShell for suspend and tree kill | Tolerable | It works; serializing the calls (M-12) is enough. |
| Docs and plans under `docs/superpowers/` (~1,700 lines of AI planning artifacts) | Low | Archive or label them as historical, so new engineers don't read them as current. |

---

## 10. Recommended Target Architecture (incremental)

Keep the current process model, a single main process plus one sandboxed renderer. It suits a local single-user tool, and no rewrite or service split is warranted. Evolve it as follows:

1. **A policy layer in main.** Create `main/policy/` holding every "may this happen without asking?" decision:
   - path confinement (`resolveAllowed`);
   - command classification (an allowlist);
   - team rules (bound to content hashes);
   - automatic-check gating;
   - PR-comment trust.

   The renderer *proposes* and main *decides*; today some of these decisions (team rules, voice confirm) live in the renderer. Add invariant tests that every privileged handler routes through it.
2. **Decompose `fleet.ts`:**
   - `fleet/server.ts` (JSON-RPC transport and auth);
   - `fleet/tools.ts` (tool implementations, with `toolDenial` checked first);
   - `fleet/worktrees.ts`;
   - `fleet/merge.ts`;
   - `fleet/state.ts` (schema-validated load and save).
3. **A typed IPC contract as the only path.** Move channels into `IpcContract` area by area, and have `register()` take typed handlers so a mismatch is a compile error. Validate argument shapes with the same declarations (a small hand-rolled schema; no new dependency is needed).
4. **Renderer state slices.** Split `useApp` into `board` (persisted), `view` (camera, selection, focus; not persisted), `runtime` (live, statuses) and `ui` (panels, toasts). Persist only `board`, with the existing debounce.
5. **A main-process I/O worker** for large JSON writes (board, usage cache) and usage scanning, keeping the existing durable-write semantics.
6. **An optional sandbox for automatic checks**, behind a capability probe (bubblewrap on Linux, a restricted job on Windows). Fall back to "ask first" when it is unavailable.

---

## 11. Testing and Verification Results

| # | Command | Outcome | Limitations |
|---|---|---|---|
| 1 | `ls node_modules` | **Absent.** Dependencies were not installed, per the audit rules. | This blocks typecheck, lint, build and e2e. |
| 2 | `npm audit --package-lock-only --omit=dev` | **Passed: 0 vulnerabilities** | Lockfile-based; registry data as of 2026-10-25. |
| 3 | `npm audit --package-lock-only` | **Passed: 0 vulnerabilities** | As above. `git status` confirmed the lockfile was unmodified. |
| 4 | Unit tests through a dependency-free loader: a copy of `test/support/hooks.mjs` in the session scratchpad, with oxc swapped for Node 22's `module.stripTypeScriptTypes`. Each `test/unit/*.test.ts` was run separately with `FLEETBOARD_HOME` pointed at the scratchpad. | **68/103 files ran and passed.** 569 cases reported in total: **490 passed, 34 skipped, 45 "failed"**. Every failure is an import error from a missing package (`zustand` ×22, `@xterm/xterm` ×6, `node-pty` ×5, `marked` ×2, `lucide-react` ×1) or `.tsx` that the strip-only loader can't handle (×2). **0 assertion failures.** | 35 files (mostly renderer engine/voice/inbox tests, plus the PTY and screen tests) **could not be run**. This is not the project's own loader, but the semantics match for `.ts`. The skips are platform conditions (Windows-only, `/proc`) and 32 agent-flag checks for CLIs not installed here. Claude Code's flag check ran and passed. |
| 5 | `npm run typecheck`, `typecheck:strict`, `lint` | **Not run** | Needs `node_modules` (TypeScript 7, oxlint, type packages). The global `tsc` is 6.0.2 with no type packages, so its output would be meaningless. |
| 6 | `npm run build`, `npm run test:e2e`, `bench` | **Not run** | Needs Electron and node-pty builds, which means installing. |
| 7 | Secret scan: regexes for GitHub, Anthropic, OpenAI, AWS and Google keys and PEM private keys, over the tree and full `git log -p` | **No matches** | Pattern-based only. |
| 8 | Static metrics (grep) | 167 `any`; 0 `@ts-ignore`; 24 lint suppressions (23 exhaustive-deps); 30 silent `.catch(() => {})`; ~60 empty `catch {}` blocks (most commented as intentional) | Counts are approximate. |

**How meaningful the existing tests are:** high. The suite tests behavior rather than implementation:
- recorded real-CLI screens replayed through the real status model;
- an e2e fake CLI that speaks MCP and runs the actual hook commands;
- leak, crash and CSP tests;
- invariant tests that read the source.

**Coverage gaps that map to findings in this report:**
- done-when auto-execution after merges (H-1);
- team-rule deny-list adversarial cases (H-3: `rm -f -r`, `git -C`, `node -e`);
- concurrent `pty:spawn` for the same id (H-4);
- startup with malformed fleet state (H-5);
- voice confirm after a workspace change (H-6);
- relative-path confinement (M-1);
- `git:diff` traversal (M-2);
- Done after post-finish commits (M-4).

Each of these is a small, deterministic unit test.

---

## 12. Remediation Roadmap

### Immediate: critical risks (about 1 week, one engineer)
| Item | Findings | Depends on | Benefit | Regression risk |
|---|---|---|---|---|
| Team-rule allowlist plus script-hash binding | H-2, H-3 | none | Restores the approval guarantee | Low: more prompts, which is the safe direction |
| Gate automatic done-when runs | H-1 | none | Removes unsandboxed agent-code execution | Low: the user clicks "Run check" instead |
| `resolveAllowed()`; fix `git:diff`/`show`; fence secrets in the state dir | M-1, M-2 | none | Closes the confinement bypasses | Medium: callers passing relative paths must be checked (the e2e smoke-content test passes `src/app.ts`) |
| Single-flight spawn; guarded startup | H-4, H-5 | none | No zombie or duplicate agents | Low |
| Freeze voice targets; same-card guard | H-6, M-5 | none | No unintended kills or approvals | Low |
| Regression tests for each of the above | §11 gaps | the items above | Locks the fixes in | none |

### Short term: high-value corrections (2–4 weeks)
- **M-3, M-4, M-7, M-8, M-9:** branch-safety recomputation; immutable team `projectPath`; project-id checks after awaits; a dead-renderer quit path. Effort S each. Risk low.
- **M-12, M-13:** Windows suspend serialization and the creation-time check. Needs Windows CI, which exists.
- **M-10:** cheap persistence wins (skip the schema re-read, skip `saveApp` when unchanged).
- **L-1, L-3, L-5, L-19:** docs fixes, fuses, SHA-pinned actions, an `engines` field.
- Add coverage reporting to CI (advisory).

### Medium term: architectural improvements (1–3 months)
- Introduce the main-process policy layer; move team rules and voice-confirm decisions into main (§10.1).
- Decompose `fleet.ts` (§10.2), with tests extracted alongside.
- IPC contract migration: fs, git and fleet first (M-15).
- Renderer state slices; take the camera out of persistence (M-11).
- Usage index rework (M-14).
- **Dependencies:** the policy layer should come before the `fleet.ts` split, so the split moves code into a structure that already exists.
- **Risk:** medium. Lean on the e2e suite with `FB_E2E_JOBS=3` and the leak tests.

### Long term: scalability and engineering maturity (3–12 months)
- Sandboxed automatic checks (§10.6).
- Code signing and provenance; optional opt-in crash reporting (local-first, the user sends it).
- A daily snapshot tier and history pruning.
- macOS support, if that is wanted: `platform.ts` already isolates the OS differences.
- **Bus factor:** contributor docs, a CODEOWNERS file, and recorded design rationale for the trust model (`docs/SECURITY.md`) so the next maintainer inherits the reasoning, not just the code.

---

## 13. Final Engineering Verdict

**1. Would you approve this repository for production deployment?**
- **For its intended use, a single developer running it on their own machine: yes, conditionally.** The conditions are the Immediate items (H-1 to H-6, M-1 and M-2), about a week of work.
- **For distribution to a wider audience: not yet.** It also needs a signed installer, fuses, and the policy layer, so the approval guarantees don't depend on renderer-side heuristics.

**2. Would you feel comfortable maintaining this codebase?**
Yes. The conventions are explicit, the tests are behavioral and fast, and the comments explain *why*, which is rarer than it should be. My discomfort is concentrated in `fleet.ts` and in the untyped IPC surface.

**3. The three biggest engineering risks:**
1. **The human-approval gate can be bypassed by a prompt-injected agent** through text-matched team rules, regex deny lists, and automatic done-when checks (H-1 to H-3).
2. **Screen-scraped prompt detection for third-party TUIs** is a brittle foundation that approvals, the phone Inbox and team rules all depend on. It is well tested today, but every CLI release is a potential silent break.
3. **Concentration risk:** one maintainer, and one 1,573-line module holding the merge and branch-deletion logic.

**4. Which architectural decisions are strongest?**
- The IPC boundary: frame-checked sender, an allowlist, and validation in both preload and main.
- Answers anchored to the screen with the `seen` fingerprint, which avoids approving a prompt that has changed.
- Durable and recoverable persistence.
- Centralized hardened process execution (`run.ts`).
- Invariant tests that turn security rules into CI failures.

**5. Which decisions are most likely to cause future problems?**
- Using a command's *string* as a proxy for its *behavior* in automation.
- Renderer-side policy decisions.
- The camera and other view state in persisted project state.
- An untyped `extras` bag.
- Synchronous I/O on the main process that also carries terminal output.

**6. What would you fix first as the responsible Principal Engineer?**
H-2 and H-3 together: the team-rule allowlist plus hash binding. Then H-1, the same week. They share a root cause, and fixing that root cause first stops later features from building on it.

**7. What should remain untouched because it already works well?**
- `writeDurable` and the store's recovery logic.
- `guardedIpc` and `trustedSender`.
- `localserver.ts` and `remote.ts` request checks.
- The `sanitizeHtml` and `safeUrl` allowlist.
- `run.ts` git hardening (extend it, don't redesign it).
- Orphan cleanup.
- The recorded-cast test approach and the e2e fake agent.

**8. What important conclusions remain unverified?**
- Whether the project's own typecheck, lint, build and e2e suites pass at this revision. They were not run because there was no `node_modules`; CI history is the only evidence.
- The 35 unit test files that need dependencies.
- All Windows-specific findings (M-12, M-13, L-10), which come from code reading only.
- Whether Codex's workspace-write sandbox can reach the loopback MCP server or read the token files (bears on M-6).
- Whether Claude Code follows symlinked `node_modules` in worktrees when writing.
- The exact Chromium data-URL limit behavior for `pdf:fromHtml` (L-2).
- Real-world performance under 50 live model sessions (only the shell-output benchmark exists).
- Whether main validates a mismatched projectId in `fleet:mergeReady`/`fleet:discard` (M-7).

---

### Appendix A: areas examined
- **main/:** all 45 modules. `index`, `ipc`, `roots`, `fsops`, `localserver`, `hooks`, `remote`, `permissions` and `paths` were reviewed directly. `fleet`, `git`, `ci`, `run`, `cli`, `goal`, `live` and the agent catalog got a specialist security review. `store`, `pty`, `orphans`, `suspend`, `usage`, `journal` and `errors` got a specialist reliability review.
- **preload, shared/:** IPC, approvals, agents and fleet reviewed directly.
- **renderer/:** a specialist review of all 165 files; the voice confirm path was verified directly.
- **CI/release/dependabot, the build config, the launch scripts, and docs (README, ARCHITECTURE, HARDENING).**
- **Not examined in depth:** `remote-page.ts` (the generated phone JS), the diagram studio internals, themes, the QR encoder (covered by a reference-fixture test), and the CSS.

---

## 14. Remediation status (branch `fix/audit-findings`)

The sections above are the audit as it stood at `83d247d`; they are left as written. This section records what was done about each finding afterwards, and what was **not** done or only partly done. Each fix has a regression test unless noted, and the High fixes were checked to fail without the change where that was practical (double spawn, voice targets, relative paths, mismatched-project Inbox).

**Verification of the fixed tree** (commands run in this environment after `npm ci --ignore-scripts` and a local `node-gyp` build of `node-pty`):

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.json` | clean |
| `tsc --noEmit -p tsconfig.strict.json` | clean |
| `oxlint` | 0 errors, 44 warnings (unchanged from the baseline before the changes) |
| `npm test` | 873 tests: 839 pass, 0 fail, 34 skip (the skips are CLIs not installed here, and platform conditions). Baseline before the changes: 830 / 796 / 0 / 34 |
| `npx electron-vite build` | succeeds |
| `npm run test:e2e` (headless, 3 files at a time) | 135 tests: 118 pass, 0 fail, 17 skip (the real-CLI suites and the opt-in benchmark). A first run found 3 failures caused by these changes (a stale-board project root that blocked starting a team in a just-opened folder, and a test reading a token the config no longer holds); both were fixed and the whole suite re-run |
| `npm audit` | 0 vulnerabilities (run during the audit; dependencies unchanged since, only `engines` added) |

**Not verified:** anything Windows-specific (M-12, M-13, L-10, the installer, Electron fuses in a packaged build: `electron-builder` was not run), the real-CLI suites, and a live Claude Code run against the team flow (only the scripted fake). The one real-CLI check made was that Claude Code 2.1.310 expands `${VAR}` in an MCP config's headers, which M-6 relies on.

### Fixed

| Finding | What changed | Tests |
|---|---|---|
| H-1 | Merged work no longer runs the done-when check by itself; the plan shows "new work not checked" and a button runs it (`fleet:runCheck`). The baseline still runs on its own | `live-work` (unit and e2e) |
| H-2 | A team rule is bound to a fingerprint of the files that define commands, taken where the user said yes; main compares it in the asking console's folder on every answer | `team-rule-binding`, `console-status` (e2e) |
| H-3 | `teamRuleAllowed` is an allowlist of single plain commands (tests, checks, builds, reads); main enforces it too; `commandNote` names `rm -f -r`, `rm --recursive`, `git -C . push`, `find -delete`, `npm ci` | `team-rules` |
| H-4 | `pty.spawn` shares a start in flight; `loginEnv` shares its read; an old process's exit no longer marks its replacement exited | `pty-dispose` (fails without the fix: two pids) |
| H-5 | Each startup step is guarded, the window always opens and names what failed; malformed team state files are set aside | `fleet-state-load` |
| H-6 | A parked voice plan is pinned to the consoles it named and dropped if the workspace changed; "delete the group" confirms for any tile and goes through the board's Delete with Undo | `planner` |
| M-1 | `allowedPath()` returns the path as checked and every handler uses it; the private parts of `~/.fleetboard` are out of reach of the fs handlers | `fsops-confine` (fails without the fix), `roots*` |
| M-2 | `git:diff` refuses a path outside the repository; `git:show` checks its folder | `git-ops` |
| M-3 | Team handlers accept only an allowed absolute folder; a team with live members keeps its folder. The e2e run showed this needed a companion fix: a newly opened folder is now the project root at once, and a background save of the board being left no longer takes that over | `fleet-state-load`, `roots`, `team-folder` (e2e) |
| M-4 | Done recounts the Lead's commits when pressed | `fleet-worktrees` (real repository) |
| M-5 | A spoken answer only acts on the Inbox card that was in front when push-to-talk began | `planner` |
| M-7 | The fleet mirror ignores a stale project's state; the Inbox never builds from another project's team | `inbox-charter` (fails without the fix) |
| M-8 | Handoff re-reads the store after writing the brief and stops if the project or the sources changed | `handoff-await` |
| M-9 | A dead or silent page no longer makes the window unclosable: the main process asks natively | none (needs a crashed page; checked by reading only) |
| M-12 | Windows pause and resume calls for a console run in order | none (Windows) |
| M-13 | The Windows tree walk skips a "child" older than its parent | `suspend` (the TS side; the PowerShell mirror is untested) |
| Helm | The confirm lists every console with its exact text; multi-step routes are gated like planner output | `helm-*` still pass |
| L-1, L-5 | README corrected; actions pinned to SHAs | none |
| L-2 | `pdf:fromHtml` always destroys its window, prints from a temp file, and its session may load no other local file | `pdf` (e2e) |
| L-3 | Electron fuses configured in `electron-builder.yml` | none (not packaged here) |
| L-4 | Releases carry `SHA256SUMS.txt` | none |
| L-6 | A Wi-Fi phone link lasts a day | `remote` |
| L-7 | MCP server: header timeout, bytes decoded once, non-object bodies answered 400 | none |
| L-8 | A member whose CLI will not start releases its slot and worktree and says why | none |
| L-9 | Goal checks settle when spawn throws; headless runs stop after 20 minutes; `fleet_merge` aborts only a merge it left half done | `goal-check`, `cli-run` still pass |
| L-10 | An argument cmd.exe would expand (`%NAME%`) is refused | `platform` (the pattern only) |
| L-11 | Git hardening reaches git started by `gh` and submodules through `GIT_CONFIG_*` | `git-safety` |
| L-12 | A cached "can write" lasts 10 minutes | none |
| L-13 | Daily snapshot tier; Forget removes snapshots; old `.tmp` / `.corrupt` files cleared; locked `app.json` retried and reported as unreadable, not damaged; journal keeps every rotated part | `store-housekeeping`, `journal` |
| L-14 | Repeated renderer errors are logged a few times a minute, then counted | `error-repeats` |
| L-15 | Console buffer trims once a quarter over, at a line start | `pty-buffer` |
| L-16 | A web tile in any session but its own is not attached | none |
| L-17 | CSP gains `object-src`, `base-uri`, `form-action` `'none'`; markdown keeps only the renderer's own classes and prefixes ids | `sanitize` (e2e) |
| L-18 | STT model switch answers pending work; terminal re-attach holds live output until the replay is in; `extractJson` is linear and finds JSON after a bracket in prose | `extract-json` |
| L-19 | `engines.node` and `.nvmrc` | none |
| L-20 | One name comparison (`nameKey`) and one typing-target check | existing resolver tests |

### Partly done

| Finding | Done | Left |
|---|---|---|
| M-6 | Claude members' MCP token moved out of the config file into the console's environment | Gemini members still get theirs in a settings file under `gemini-homes/` (Gemini reads MCP servers only from settings), and a same-user process can read another's environment through `/proc`. Role checks remain defence in depth, not isolation |
| M-10 | The schema re-read is cached; `app.json` is rewritten only when its entry changed | Each save still pretty-prints, writes and fsyncs the board on the main thread |
| M-11 | `App`, `TopBar` and `Wires` no longer re-render on every camera frame | The camera is still part of the persisted project (each pan still schedules a save), and `Board` and the other chrome still select the whole project |
| M-14 | The sorted event list is memoised per cache change; the cache is written at most every five minutes | The cache still holds every event for all time (no rolling index) |
| M-15 | 35 of 116 invoke channels are typed, a test stops the untyped list growing, and typed channels must be called through `request()` | 81 legacy channels remain untyped |
| L-17 | New directives and the markdown class and id rules | `connect-src https:` and `img-src https:` stay wide: model downloads and remote images in READMEs need them |
| L-18 | See above | Background engines still have no teardown, so a Vite hot reload in dev duplicates their timers |
| L-4 | Checksums | The installer is still unsigned and has no build provenance attestation |

### Not done (by design, or out of scope for a fix)

- **Code signing** needs a certificate the project does not have.
- **The policy layer, the `fleet.ts` split, renderer state slices, a main-process I/O worker and sandboxed checks** (§10, §12 medium and long term) are architectural programmes, not fixes to findings. H-1 to H-3 close the gaps they were meant to prevent; the structure is unchanged.
- Items listed as unverified in §13 question 8 are still unverified, apart from the one Claude Code behaviour noted above.
