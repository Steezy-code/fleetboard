# Live work and Oracle, scoped: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a team works, every tile says what its agent is doing, for how long and against what estimate, what it has changed so far and whether the charter's check is getting closer — and Oracle reads all of it, speaks up in one quiet line only when the work drifts from the charter, and answers about just the tiles the user pointed at.

**Architecture:** Two producers in the main process, both without a model: the PTY manager parses Claude Code's tool-call lines off the console's screen into an activity string, and a new `live.ts` tick samples each worker's worktree diff, stamps each member's last output and runs the charter's done-when through `goal.ts` in the Lead's integration worktree. What they find is written to fleet state as progress fields (never the agreed charter fields) or emitted as a console event. The renderer only reads: the tile and the plan node render it, `drift.ts` turns it into at most one locally composed sentence, and the Oracle context builder includes it and narrows itself to the board selection.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React + zustand, `node:test` + `node:assert/strict` run by `scripts/test-unit.mjs`; e2e through `test/e2e/harness.ts` with the scripted `test/fake-agent/claude.mjs`.

**Spec:** [docs/superpowers/specs/2026-10-21-charter-and-understanding-design.md](../specs/2026-10-21-charter-and-understanding-design.md)

**Scope:** Spec sections 4 (live work against the charter) and 5 (Oracle, scoped). This is plan 3; it depends on plan 1 ([2026-10-21-charter-and-gate.md](2026-10-21-charter-and-gate.md), on master) and not on plan 2 (the project profile). Where Oracle would read the profile, the context builder has a marked seam and reads nothing until plan 2 lands.

## Global Constraints

- **No model call anywhere in this plan.** Activity, drift and the ambient sentence are all composed locally. The only new model-written text is two optional fields in the existing charter and plan replies.
- Nothing uploaded. No new network traffic of any kind: git runs locally, the done-when runs in the user's own shell.
- Linux and Windows both. Shelling out goes through `run.ts` (git) or `goal.ts` (the check), which already use `src/main/platform.ts`.
- **Stall detection does not depend on the estimate.** Silence alone raises the Inbox card, so it works on the first goal in a fresh repo.
- **The done-when command is never run unseen:** only the charter's own `doneWhen`, which the card already shows verbatim, only in the Lead's integration worktree, only while that Lead is working, never overlapping itself, and the user can switch it off.
- The agreed charter fields stay the user's. Check results, timings and diffs are progress fields on the fleet state, written beside the charter, never into it.
- Existing state must load: every new field is optional.
- No new dependencies.
- House style: comments explain why, not what. Sentence case in UI copy.
- Running tests is as in plan 1: `node scripts/test-unit.mjs` for the suite, and one file with
  `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/<name>.test.ts`.
  e2e: `npm run build` once, then `FB_E2E_HEADLESS=1 node --enable-source-maps --import ./test/support/register.mjs --test --test-concurrency=1 test/e2e/<name>.test.ts`.

## Reading of the spec where it leaves room

- **"A field the charter model emits per task."** The charter is drafted before the Lead has planned, so the charter model cannot name the Lead's tasks without doing the Lead's planning, which the spec rules out as a non-goal. So the charter model emits one `estimate` for the job, and `fleet_plan` takes an optional estimate per task from the Lead in the same reply that names the tasks. Both are model-emitted numbers carried on the objects they describe; neither is accumulated from history.
- **"Running it periodically."** The integration worktree only changes when the Lead merges (the Lead never edits files), so a run on an unchanged commit tells nothing new. The check runs once as a baseline when the team starts, after each merge, and on a slow tick only if the integration branch moved since the last run. The run after the last merge is the one the Ready card is read against. That is the cheap reading of "periodically" and still never overlaps itself.
- **Where the ambient line lives.** Its own one-line strip above the Inbox tray, not an Inbox item: an Inbox item asks for an answer, and the line asks for nothing.

## Review Focus

Six things the spec implies, that no task's happy path exercises, most likely to bite first. Each has a test in the task that owns the code.

1. **A stale verb.** The last tool line on screen can belong to the previous turn, or sit above a prose reply that came after it. Activity must be read only from the current turn and only when the tool line is the newest bullet — "a wrong verb is worse than no verb". (Task 1)
2. **Text that looks like a tool line but is not one**: a prompt typed into the input box, a quoted `Bash(x)` in a reply, Gemini's `✓ Shell …` box. None of these may parse. (Task 1)
3. **A model-written done-when that is not a command** ("the page renders correctly"). Run as shell input, that is at best an error on a loop and at worst a command. Only a command-shaped done-when runs; anything else shows "not a command, not run". (Task 7)
4. **An app restart mid-team.** `lastOutputAt` comes back from disk older than the restart, so every member would read as silent for the length of the outage. Silence is measured only from output this run of the app has seen. (Task 4)
5. **The ambient line talking too much.** On track must produce nothing; one drift must produce one line; a dismissed drift must not come back until something new happens. (Task 9)
6. **A selection that is not consoles.** A kanban card, a group, a wire or an ink stroke in the selection must scope the context to what it is, and a selection of only wires or ink must not scope it to nothing. (Task 10)

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/main/activity.ts` | `activityOf(agentId, screenText)`: Claude Code's tool-call lines → "editing `src/main/pty.ts`". Pure. |
| Modify `src/main/pty.ts` | Parse while a console works, emit `pty:activity`; `lastOutput(id)`. |
| Create `src/renderer/src/engine/activity.ts` | The renderer's mirror of each console's activity. |
| Modify `src/renderer/src/nodes/ConsoleNode.tsx` | The status pill says the activity; a worker's tile shows its live diff. |
| Create `src/shared/live.ts` | Pure helpers for time, estimates, the diff, the decision log and the done-when trend. |
| Modify `src/shared/fleet.ts` | `FleetTask.startedAt/endedAt/estimate`, `FleetMember.lastOutputAt/diff`, `FleetState.check`. |
| Modify `src/shared/charter.ts`, `src/renderer/src/fleet/charter.ts` | `Charter.estimate`, and the prompt line that asks for it. |
| Modify `src/shared/mergeReview.ts` | `stalled()` measures silence, not age. |
| Create `src/main/live.ts` | The tick: stamp output, sample diffs, run the done-when. |
| Modify `src/main/goal.ts` | `runGoalCheck` takes an `AbortSignal`. |
| Modify `src/main/fleet.ts` | Task timing, `fleet_plan` estimates, the decision-log prompt line, check triggers, `fleet:checkOff`. |
| Modify `src/renderer/src/nodes/PlanNode.tsx` | Elapsed against estimate per task, the done-when line with its switch. |
| Create `src/shared/drift.ts` | `driftOf(state, now, …)`: the one sentence, or nothing. Pure. |
| Create `src/renderer/src/fleet/AmbientLine.tsx` | The strip; mounted in `BottomBar.tsx`. |
| Modify `src/renderer/src/voice/helm/context.ts` | The charter and live state in Oracle's snapshot; scoped to the selection. |
| Modify `src/renderer/src/fleet/inboxModel.ts`, `InboxTray.tsx` | The stall card's wording; decisions on the Ready card. Kept to a few lines: PR #10 is in the same files. |
| Create `test/unit/activity.test.ts`, `live-work.test.ts`, `drift.test.ts`, `context-scope.test.ts` | Tasks 1, 3–7, 9, 10. |
| Create `test/e2e/live-work.test.ts` | The UI: activity on the tile, timings and the check on the plan, the diff, the ambient line. |
| Modify `test/support/casts.ts`, `test/fake-agent/claude.mjs` | Screen text at marks and at a time; a fake that holds a step long enough to be seen. |

---

### Task 1: Claude Code's tool lines become an activity

**Files:**
- Create: `src/main/activity.ts`
- Modify: `test/support/casts.ts` — `MarkResult.text`, and `screenAt(cast, ms)`
- Test: `test/unit/activity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** what a console is doing, from what its terminal shows; null when its output does not say */
  export function activityOf(agentId: string, text: string): string | null
  ```

It reads `TermScreen.text()`, which keeps the `●`/`⏺` and `⎿` glyphs Claude Code marks tool calls with — `cleanTail` in `helm/context.ts` strips exactly those, which is why this cannot run on Oracle's tail.

- [ ] **Step 1: Write the failing tests** — against the recorded casts, at their marks and at a moment inside the `sleep 7` run:
  - `needs-you: bash permission` → ``running `touch made-by-bash.txt` ``; `needs-you: edit permission` → ``writing `notes.txt` ``.
  - `working: thinking` (a new turn, no tool drawn yet) → null — Review Focus 1.
  - `idle: after bash` (a prose bullet after the tool line) → null — Review Focus 1.
  - two seconds before the `sleep 7` PostToolUse hook → ``running `sleep 7 && echo finished` ``.
  - every mark of `claude-adversarial.cast`, and the final screens of the Codex and Gemini casts, through the Claude parser → null — Review Focus 2.
  - `activityOf('codex', …)` → null whatever the text.
  - synthetic lines: `● Update(src/main/pty.ts)` → editing; `● Read(…)`; `● Search(pattern: "x")`; `● fleet - fleet_wait (MCP)(timeout_seconds: 170)` → "waiting for the team"; an unknown tool → "using <Tool>"; a 300-character argument is clipped.

- [ ] **Step 2: Run them and watch them fail** — cannot find `src/main/activity`.

- [ ] **Step 3: Write `activityOf`** — the current turn is the rows after the last echoed prompt (`❯ ` at column 0 that is *not* the input box, which has a rule right above it), up to the first rule after that (the input box, or a dialog drawn over it). The newest `●`/`⏺` bullet in that range decides: a `Tool(args)` or `server - tool (MCP)` shape is a tool call and maps to a verb; anything else is prose and means null.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `git commit -m "What a console is doing, read off its screen"`

---

### Task 2: The activity reaches the tile

**Files:**
- Modify: `src/main/pty.ts` — parse on the status tick while working; `pty:activity`; `lastOutput(id)`
- Create: `src/renderer/src/engine/activity.ts`; modify `src/renderer/src/engine/consoles.ts` to wire it
- Modify: `src/renderer/src/nodes/ConsoleNode.tsx` — the pill
- Modify: `test/fake-agent/claude.mjs` — a solo rule's `holdMs` after its tool line
- Test: `test/e2e/live-work.test.ts`

**Interfaces:**
- Produces: event `pty:activity (id: string, text: string | null)`; `PtyManager.lastOutput(id): number | null`; `useActivity` store `{ of: Record<string, string> }`.

Parsing happens only on the existing 700 ms status tick, only while the console is `working` and only when output arrived since the last parse, so an idle board costs nothing. Leaving `working` clears it.

- [ ] **Step 1: Write the failing e2e test** — a fake Claude console with a scripted `sleep` that holds for a few seconds: its pill reads ``running `sleep 3` `` while it holds, and `working`/`ready` after.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Emit from `PtyManager`, mirror in the renderer, show in the pill** — the pill falls back to its status label whenever there is no activity, which is the plain "working" the spec asks for on Codex and Gemini.
- [ ] **Step 4: Run it and the console-status e2e, and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "The tile says what its agent is doing"`

---

### Task 3: Elapsed time against an estimate

**Files:**
- Modify: `src/shared/fleet.ts`, `src/shared/charter.ts`, `src/renderer/src/fleet/charter.ts` (`CHARTER_FIELDS`)
- Create: `src/shared/live.ts`
- Modify: `src/main/fleet.ts` — `fleet_plan` takes `estimates`; task status changes stamp `startedAt`/`endedAt`
- Modify: `src/renderer/src/nodes/PlanNode.tsx`
- Test: `test/unit/live-work.test.ts`, `test/unit/charter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // FleetTask gains: startedAt?: number; endedAt?: number; estimate?: number  (minutes)
  // Charter gains:   estimate?: number  (minutes, the whole job)
  export function minutes(ms: number): number
  /** "12 min, est 5", "took 12 min", "4 min" */
  export function elapsedLabel(t: { startedAt?: number; endedAt?: number; estimate?: number }, now: number): string
  export function overEstimate(t: { startedAt?: number; endedAt?: number; estimate?: number }, now: number): boolean
  export function stampTask(t: FleetTask, status: FleetTask['status'], now: number): void
  ```

- [ ] **Step 1: Write the failing tests** — the label with and without an estimate, running and finished; a task first set `doing` gets `startedAt` once and keeps it through `review` → `doing`; `endedAt` set on `review`/`done`/`blocked` and cleared on `doing`; `coerceCharter` keeps a sane `estimate` and drops `0`, negatives, strings and absurd values; `CHARTER_FIELDS` asks for it.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** — `fleet_plan`'s schema gains `estimates: number[]`, same order as `tasks`, like `notes` on `fleet_ask_user`; the Lead prompt's rule 2 asks for it. Every status write in `fleet.ts` goes through `stampTask`. The plan node shows the label per task and the job's against the charter estimate; over the estimate it is coloured, and nothing else happens — the estimate never raises a card.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "How long each task has taken, against what it was expected to"`

---

### Task 4: A stall is silence, not age

**Files:**
- Modify: `src/shared/mergeReview.ts` — `stalled()`
- Create: `src/main/live.ts` (the tick, its first job); register it from `src/main/index.ts` after `fleet`
- Modify: `src/renderer/src/fleet/inboxModel.ts` — the stall card's wording only
- Test: `test/unit/merge-review.test.ts`, `test/unit/live-work.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // FleetMember gains: lastOutputAt?: number
  export const QUIET_MINUTES = 5
  export function stalled(s: FleetState, now: number, quietMinutes = QUIET_MINUTES, since = 0): Stall[]   // Stall.minutes is now minutes silent
  export function stampOutput(m: FleetMember, at: number | null, now: number): boolean  // in live.ts's pure half
  ```

The tick reads `ptys.lastOutput(id)` every 15 s and writes it to the member only when it moved by 30 s or more, so a chatty console does not rewrite the fleet file every tick. `since` is when this run of the app started: silence is never counted from before it (Review Focus 4).

- [ ] **Step 1: Write the failing tests** — a member old but talking is not stalled; one silent past the threshold is, with its silent minutes; reported and merged members never are; a `lastOutputAt` older than `since` counts from `since`; `stampOutput` skips sub-30 s moves.
- [ ] **Step 2: Run them and watch them fail** — and rewrite the existing `stalled` test, which encoded the age reading the ponytail note asked to replace.
- [ ] **Step 3: Implement**, and change the card's head to "has been silent for 7 min", its Dismiss and Ask for a status unchanged.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "A worker is stalled when it goes quiet, not when it gets old"`

---

### Task 5: The work is visible before Ready

**Files:**
- Modify: `src/main/live.ts` — a diff sample per working worker
- Modify: `src/shared/live.ts` — `LiveDiff`, `diffLabel`
- Modify: `src/renderer/src/nodes/ConsoleNode.tsx`, `PlanNode.tsx`
- Modify: `test/fake-agent/claude.mjs` — a worker's `holdMs` after it writes
- Test: `test/unit/live-work.test.ts`, `test/e2e/live-work.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LiveDiff { files: number; add: number; del: number; at: number }
  // FleetMember gains: diff?: LiveDiff
  export function liveDiff(numstat: string, untracked: string, at: number): LiveDiff
  export function diffLabel(d: LiveDiff | undefined): string   // "3 files +40 −2"; '' for none
  ```

`git diff --numstat HEAD` plus `git ls-files --others --exclude-standard -z` in the worker's own worktree, every 15 s, one sample per worker at a time, written only when it changed. A worker never commits before it reports, so uncommitted-against-HEAD is exactly its work.

- [ ] **Step 1: Write the failing tests** — `liveDiff` counts tracked and untracked files once each and binary files as zero lines; the label; and in e2e, a worker holding after it writes shows its diff on its tile and on the plan before the Ready card exists.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "What each worker has changed, while it changes it"`

---

### Task 6: One line per real choice

**Files:**
- Modify: `src/main/fleet.ts` — `workerPrompt` (and so the inline rules `briefFor` gives non-Claude workers)
- Modify: `src/shared/live.ts` — `decisionsOf(report)`
- Modify: `src/renderer/src/fleet/InboxTray.tsx` — the Ready card's claim rows
- Test: `test/unit/fleet-roles.test.ts`, `test/unit/live-work.test.ts`

**Interfaces:**
- Produces: `export function decisionsOf(report: string | undefined): string[]`

- [ ] **Step 1: Write the failing tests** — the worker prompt asks for a `Decisions:` section, one line per real choice, and says to leave it out when there were none; `briefFor` for a Codex worker carries the same line; `decisionsOf` reads the lines under `Decisions:` whatever their bullet, stops at the next heading, and returns `[]` without one.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, and show up to three decisions under each worker's claim on the Ready card.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "Workers say what they chose, one line each"`

---

### Task 7: The charter's check, live

**Files:**
- Modify: `src/main/goal.ts` — `runGoalCheck(cwd, command, timeoutMs, signal?)`
- Modify: `src/main/live.ts` — the runner
- Modify: `src/shared/live.ts` — `commandLike`, `failingCount`, `checkTrend`
- Modify: `src/shared/fleet.ts` — `FleetState.check`
- Modify: `src/main/fleet.ts` — triggers at start and merge; `fleet:checkOff`; a dismissed team's run is stopped
- Modify: `src/renderer/src/nodes/PlanNode.tsx` — the done-when line and its switch
- Test: `test/unit/live-work.test.ts`, `test/e2e/live-work.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CheckRun { at: number; code: number | null; failing?: number; head?: string; error?: string }
  export interface DoneWhenCheck { command: string; off?: boolean; running?: number; runs: CheckRun[] }
  // FleetState gains: check?: DoneWhenCheck
  export function commandLike(doneWhen: string): boolean
  export function failingCount(tail: string): number | undefined
  /** "3 failing, down from 11" · "passing" · "failing" · "running…" · "off" · "not a command, not run" */
  export function checkTrend(c: DoneWhenCheck | undefined, doneWhen: string): string
  /** whether a run may start now; the reason it may not, otherwise */
  export function mayRun(o: { command: string; off?: boolean; running?: number; leadWorking: boolean; inWorktree: boolean; head?: string; lastHead?: string; reason: 'start' | 'merge' | 'tick' }): true | string
  ```

- [ ] **Step 1: Write the failing tests** — Review Focus 3: `commandLike` is true for `npm test`, `test -f a.txt`, `pytest -q tests/`, `./scripts/check.sh` and false for "The page renders", "tests pass", "", and for anything with a newline; `failingCount` reads node:test, jest/vitest, pytest and mocha summaries and is undefined otherwise; `checkTrend` over a run list; `mayRun` refuses when off, when running, when the Lead is not working, when the Lead has no integration worktree (a team in the user's own files), and on a tick whose head has not moved.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** — runs reuse `runGoalCheck`, in the Lead's `cwd` (its integration worktree), with a 10-minute timeout and the team's own `AbortController`, aborted when the team is dismissed. The last ten runs are kept. The command is always the charter's `doneWhen` verbatim: there is no other source. The plan node shows ``Done when `npm test` · 3 failing, down from 11`` with a switch that writes `check.off` through `fleet:checkOff`.
- [ ] **Step 4: e2e** — a team whose charter's done-when is `test -f a.txt`: a baseline run fails, a run after the merges passes, and the plan node says "passing". Switched off, no further run starts.
- [ ] **Step 5: Commit** — `git commit -m "The charter's check runs as the work lands, in the Lead's worktree"`

---

### Task 8: Oracle reads the charter and the live work

**Files:**
- Modify: `src/renderer/src/voice/helm/context.ts` — `fleetSection` and the console headers
- Test: `test/unit/context-scope.test.ts`

- [ ] **Step 1: Write the failing tests** — with a charter on the fleet state the snapshot contains its understood line, its exclusions, its done-when command with the check's trend, and the job estimate; a member's header carries its activity, elapsed against estimate, silence and diff.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, with a marked seam where plan 2's profile joins the snapshot.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "Oracle reads what the job was agreed to be"`

---

### Task 9: The ambient line

**Files:**
- Create: `src/shared/drift.ts`
- Create: `src/renderer/src/fleet/AmbientLine.tsx`; modify `src/renderer/src/chrome/BottomBar.tsx` to mount it; styles in `fleet.css`
- Test: `test/unit/drift.test.ts`, `test/e2e/live-work.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Drift { key: string; kind: 'check' | 'silent' | 'over'; who?: string; consoleId?: string; text: string }
  /** the one drift worth a line, or null: almost always null */
  export function driftOf(s: FleetState | null, now: number, o?: { live?: (id: string) => boolean; since?: number; dismissed?: Set<string> }): Drift | null
  ```

Only while a Lead is working. Three triggers, in this order of weight: the done-when going the wrong way between its last two runs (more failing, or passing to failing); a member silent past `QUIET_MINUTES`; a task (or the job) at twice its estimate and at least five minutes past it. Each sentence is built from the trigger's own fields. A key names the specific occurrence, so a dismissed drift stays dismissed until something new happens — new output then new silence, a new run.

- [ ] **Step 1: Write the failing tests** — Review Focus 5: a fresh team, a team on its estimates and a team with a green check all give null; each trigger gives its sentence; two at once give the heavier one; a dismissed key gives null, and the next occurrence gives a line again; a team that is not working gives null whatever it carries; an over-estimate under five minutes past gives null.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** — the strip recomputes every 30 s and on every fleet change, badged "Oracle", with Open (focus the console) and a dismiss.
- [ ] **Step 4: e2e** — a fleet state with a member silent for twenty minutes shows the line and the Inbox stall card together, with no estimate anywhere on the state (the fresh-repo case the spec's verification names); after dismissing the line it stays gone.
- [ ] **Step 5: Commit** — `git commit -m "One quiet line when the work drifts from its charter"`

---

### Task 10: Point and ask

**Files:**
- Modify: `src/renderer/src/voice/helm/context.ts` — `boardContext` scoped to the selection
- Test: `test/unit/context-scope.test.ts`

**Interfaces:**
- Produces: `export function selectionScope(): { consoles: string[]; nodes: BoardNode[] } | null` — null when nothing selectable is selected.

- [ ] **Step 1: Write the failing tests** — two consoles and a kanban selected out of four consoles, a note and a checklist: the snapshot names the two consoles and the kanban's cards, says it is scoped to the user's selection, and contains neither the other consoles' names or output nor the note; the selected consoles get the room the others would have used; a selected group counts as its members (Review Focus 6); a selection of only a wire gives the whole board.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** — the scoped snapshot keeps the project header, the charter and the recent thread, and leaves out the rest of the board, CI and the sweep.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `git commit -m "Oracle answers about the tiles you pointed at"`

---

## Self-review

**Spec coverage.** Section 4: current activity is Tasks 1–2; elapsed time and the estimate are Task 3; stall detection independent of the estimate is Task 4; the live diff is Task 5; the decision log is Task 6; the done-when check, live, with its three pinned rules, is Task 7. Section 5: the charter in Oracle's inputs is Task 8 (the profile is a seam until plan 2); the ambient line is Task 9; point-and-ask is Task 10. The spec's verification lines for this half — `startedAt` populates, a silent worker raises an ambient line and an Inbox card even with nothing estimated, a Codex worker shows "working", the done-when runs via `goal.ts` and its result appears, a selection's answer mentions only those — each have a test above.

**Gaps I am leaving deliberately.** The phone Inbox shows neither the ambient line nor the live diff; both read fleet state the phone already receives, so adding them is a rendering change for later. Activity is Claude Code only, as the spec scopes it; a parser for Codex's `• Ran …` lines would slot into `activityOf` beside it. The Ready card shows the last check result through the plan node, not yet as a ticked charter line.

**Type consistency.** `LiveDiff`, `CheckRun`, `DoneWhenCheck` are defined once in `src/shared/live.ts`; `src/shared/fleet.ts` imports them. `QUIET_MINUTES` is the one silence threshold, read by both `stalled()` and `driftOf()`, so the card and the line cannot disagree about who is stalled.

**Proportion.** Ten tasks against two sections of the spec, no function bodies, two rules spelled out (where activity is read from, and when the check may run) because their tests constrain but do not determine them.
