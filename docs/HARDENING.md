# Product hardening

This pass follows the path from a first goal to a reviewed result, with recovery and performance checks around it.

## Verification

Ready cards label the Lead's prose as **agent-reported**. Fleetboard's own completion checks record command, exit code, bounded output, time, and commit. A passing verdict requires the offered SHA, a clean worktree before and after the run, unchanged HEAD, and a successful process result. A dirty worktree or different SHA is explicitly unverified. The phone shows the same distinction.

The Ready card's **Run completion check** runs the charter's agreed command again in the integration worktree. It refuses a changed card or a branch that moved. A check does not make a worker's prose independently verified: worker rows say reported and merged. Merge remains a user decision, including when there is no observed check.

Checks can execute repository code, just as the agreed charter check could before this change. Cleanliness is sampled at the start and end, not a filesystem sandbox or proof that a test is meaningful.

## Integration capabilities

Claude Code, Codex and Gemini are labeled **Integrated**, with teams, prompt detection, native sessions, local usage, and read-only planning. Other catalog entries are **Terminal only**; launching a CLI does not claim validated orchestration. Shell has a separate label. These tiers describe Fleetboard's integration, not a guarantee that every installed CLI version is compatible. Existing recorded-session, flag and real-CLI tests remain the compatibility checks.

## First team

The dismissible **Your first team** guide follows goal, progress/blockers, and review/merge. Its draft button fills the command bar without starting an agent. Dismissal is saved per project. Advanced tools remain accessible in their existing places.

## IPC

`shared/ipc.ts` declares separate invoke/send/event surfaces. Both preload and the main boundary validate requests; main additionally accepts only the application's own top frame. Web tiles and child frames cannot invoke privileged handlers. The application renderer now uses Electron's sandbox.

`shared/ipc-contract.ts` and renderer `request()` provide inferred argument/result types for state, process control, completion checks and recovery. The central state and console call sites use them. Legacy feature-specific channels still use `invoke<T>` and should migrate as they change; runtime checks supplement their existing handler checks. Unit tests require every registered channel to appear in the allowlist.

## Accessibility

Shared modals and confirmations announce their title and dialog role, contain keyboard focus, handle Escape at the top dialog, and restore focus to the invoker. Confirmation dialogs focus Cancel first. Switches announce their state and setting name; segmented buttons announce selection. Drawers have named close controls and toasts use a polite live region. This is a shared-component improvement, not a complete screen-reader audit of the canvas or every custom panel.

## Performance

`FB_E2E_HEADLESS=1 npm run bench` runs 20 and 50 real shell terminals. Other terminals emit output while the test pans/zooms and probes a terminal echo. After a two-second camera warmup, it samples eight seconds of p95/max animation-frame intervals, echo latency (including automation round trips/polling), and renderer JS heap. Set `FB_BENCH_OUT=/tmp/fleetboard-benchmark.jsonl` to retain JSON. Limits are 250 ms p95, 3 seconds echo, and 1 GiB JS heap; these are regression ceilings, not a 60 FPS claim. Run on an otherwise idle machine. The workload uses Bash and skips Windows.

Offscreen tile contents skip rendering with `content-visibility: hidden` plus overscan. Nodes remain mounted, so PTYs, subscriptions, and buffers stay alive; returning to the tile shows the ongoing session. Focused nodes always render. Console frames also skip React rerenders for scale changes that do not cross the click-to-focus threshold. The default E2E suite skips the opt-in benchmark.

The E2E runner now actually bypasses Xvfb when `FB_E2E_HEADLESS=1`, matching the documented workflow, and reports missing executables rather than silently failing.

## Recovery

Settings → Data offers timestamped snapshot selection, a preview, export/import, and explicit replacement. The current board is snapshotted before replacement, even inside the normal five-minute interval. Running consoles and an undismissed team prevent replacement; reused/expired preview tokens are refused. Restoring flushes/cancels pending saves before changing state.

Portable JSON contains board content and path references, not app settings or profile directories. Import and restore bind the board to the open repository, keep saved documents and project memory while clearing automation/workspace metadata and console account/command overrides, and make every console wait for a click. Newer schemas, invalid geometry and duplicate IDs are rejected. Assets are not bundled: images and external file references must be copied separately. Recovery does not roll back repository files or revive a running team.

## Review and local validation

The final review checked stale-commit evidence, worktree changes during checks, generated phone JavaScript, nested-dialog focus, recovery save ordering, import side effects, live-console/team protection, and offscreen terminal continuity. Regression tests cover these boundaries. A generated-script syntax error and dropping passive saved documents during import were found and fixed during review.

On Linux, with an Intel Core i5-5350U, the final steady-state benchmark measured:

| Terminals | p95 frame interval | Worst frame | Echo response | Renderer JS heap |
|---|---:|---:|---:|---:|
| 20 | 51 ms | 197 ms | 235 ms | 13 MiB |
| 50 | 95 ms | 918 ms | 224 ms | 25 MiB |

Both cases met the regression ceilings. The long worst frame remains a performance limitation; these figures do not imply smooth 60 FPS. The benchmark uses a controlled shell-output workload and headless Chromium, not 50 live model sessions. Windows and real authenticated agent compatibility were not exercised in this pass. Legacy IPC result types and custom canvas accessibility remain incremental work, as described above.

Validation completed: strict and standard typechecking, lint (existing advisory React warnings remain), production build, 805 passing unit tests with 25 skips, and both benchmark cases. A full E2E run passed 113 tests and exposed the phone-script issue; the subsequent 33-test targeted run passed 30 and exposed the HEAD/diff-panel issues. After those fixes, all 11 checks in the affected live-work and smoke files passed. The other targeted phone, recovery, offscreen, board, session, web and approval checks passed. No Windows or authenticated real-agent tests were run.
