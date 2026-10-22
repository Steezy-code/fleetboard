# Charter and gate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No team work starts in a repo until the user has glanced at a charter saying what the job is, and that charter — not the raw request — is what the Lead works from and what its merge is checked against.

**Architecture:** A `Charter` is a plain object in `src/shared/`, produced by one model call at whichever door first needs it, confirmed through a new Inbox item kind, then posted to the Lead in place of the raw goal string. Confidence is computed from the charter's own evidence rather than self-reported, and decides only whether the card renders in full or as one line. The charter's `wontTouch` becomes another reason `mergeReview` flags a file, and a hit makes `fleet_merge` refuse.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React + zustand, `node:test` + `node:assert/strict` run by `scripts/test-unit.mjs`.

**Spec:** [docs/superpowers/specs/2026-10-21-charter-and-understanding-design.md](../specs/2026-10-21-charter-and-understanding-design.md)

**Scope:** This plan implements spec sections 2 and 3 (the charter, and where the gate goes), plus the merge check. Spec section 1 (project profile) is plan 2; sections 4 and 5 (live work, Oracle's ambient line and point-and-ask) are plan 3. Those two depend on this one and not on each other. Where this plan has no profile to draw on, an assumption counts as `known` only when it cites something verifiable in the repo — which is what makes this plan shippable alone, and what plan 2 then widens.

## Global Constraints

- Nothing uploaded. No new network traffic of any kind.
- Linux and Windows both, first-class. Anything that shells out goes through `src/main/platform.ts`.
- **One model call per goal.** Through Oracle the charter rides the pass already happening; only a door that never consults Oracle spends its own call.
- **Degrade, never block.** A goal in a repo with no git, no profile, or an unparseable model reply still starts — with more `guess` lines, never an error.
- Existing state must load: `~/.fleetboard` is versioned JSON, and a board saved by the current build must open.
- The agreed fields (`understood`, `assumptions`, `wontTouch`, `doneWhen`) are the user's. Nothing but the user writes them after confirmation.
- No new dependencies.
- House style: comments explain why, not what. Sentence case in UI copy.
- **Running tests.** Whole unit suite: `node scripts/test-unit.mjs`. One file:
  `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/<name>.test.ts`.
  Note `scripts/test-unit.mjs` passes its extra arguments to `node --test` as flags *before* the
  file list, so it cannot select a file by name — `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts` does not
  do what it looks like it does.

## Review Focus

Five things the spec implies, that no task's happy path exercises, most likely to bite first. Each has a test in the task that owns the code.

1. **The model returns malformed or empty JSON.** A charter must still appear, with everything as `guess` and the raw request as `understood` — never a thrown error that eats the goal. (Task 1)
2. **`wontTouch` is empty.** Empty exclusions must match *no* file. A prefix match against `''` matches everything, which would block every merge. (Task 2)
3. **Exclusion paths arrive in Windows or sloppy form** — `src\main\`, `./src/main`, `src/main/` with a trailing slash. Un-normalised, an exclusion silently matches nothing and the gate is decoration on Windows. (Task 2)
4. **`doneWhen` is empty or junk.** `runGoalCheck` returns `{ code: null, error: 'no command' }` for an empty command; the card must read that as "not checked", not as failing. (Task 1)
5. **A goal arrives while a Lead is running.** It is a follow-up: the charter must say so, and the path must not reach `startLead`, which resets `s.tasks` and `s.ready` and would discard the running team's state. (Task 5)

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/shared/charter.ts` | The `Charter` type, `coerceCharter`, `scoreConfidence`, `charterBrief`. Pure; no Electron, no fs. |
| Modify `src/shared/mergeReview.ts` | `excludedBy` beside the existing `ownedBy`; `FileFlag.excluded`; `MergeReview.blocked`. |
| Modify `src/shared/fleet.ts` | `FleetState.charter?: Charter` — one per Lead, per the spec's cardinality decision. |
| Create `src/renderer/src/fleet/charter.ts` | The producer and the gate: `openGate`, `confirmCharter`. Owns the pending-charter store. |
| Create `src/renderer/src/fleet/CharterCard.tsx` | The card body, full and one-line. |
| Modify `src/renderer/src/fleet/inboxModel.ts` | A `charter` item kind, first in the order. |
| Modify `src/renderer/src/fleet/InboxTray.tsx` | Render the new kind. |
| Modify `src/renderer/src/engine/fleet.ts` | `sendGoal` goes through the gate. |
| Modify `src/renderer/src/playbooks/run.ts` | `runPlaybook` goes through the gate. |
| Modify `src/renderer/src/voice/actions.ts` | A `send` that submits to a fleet member goes through the gate. |
| Modify `src/renderer/src/voice/helm/helm.ts` | The `team` option carries charter fields. |
| Modify `src/main/fleet.ts` | Post the charter, not the raw goal; prompts carry it; `fleet_merge` refuses on an excluded path. |
| Create `test/unit/charter.test.ts` | Tasks 1 and 4. |
| Modify `test/unit/merge-review.test.ts` | Task 2. |
| Modify `test/unit/fleet-roles.test.ts` | Task 3. |

---

### Task 1: The charter type, coercion and confidence

**Files:**
- Create: `src/shared/charter.ts`
- Test: `test/unit/charter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface CharterAssumption { text: string; known: boolean; from?: string }
  export type Ambiguity = 'scope' | 'acceptance' | 'subject' | 'constraint'
  export interface Charter {
    request: string
    understood: string
    assumptions: CharterAssumption[]
    wontTouch: string[]
    doneWhen: string
    confidence: number
    ambiguity?: Ambiguity
    question?: { text: string; options: string[] }
    /** set when this is a follow-up to a Lead already running */
    followUpTo?: string
    at: number
  }
  export function coerceCharter(raw: unknown, request: string, at?: number): Charter
  export function scoreConfidence(c: Pick<Charter, 'assumptions' | 'wontTouch' | 'doneWhen' | 'question'>): number
  export function charterBrief(c: Charter): string
  export const FULL_CARD_BELOW = 80
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/charter.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { charterBrief, coerceCharter, scoreConfidence } from '../../src/shared/charter'

test('confidence is the share of assumptions that cite evidence', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }, { text: 'c', known: false }], wontTouch: ['x'], doneWhen: 'npm test' }
  assert.equal(scoreConfidence(c), 67)
})

test('no done-when caps confidence, however many assumptions are known', () => {
  const c = { assumptions: [{ text: 'a', known: true }, { text: 'b', known: true }], wontTouch: ['x'], doneWhen: '' }
  assert.equal(scoreConfidence(c), 60)
})

test('an open question keeps the card full', () => {
  const c = { assumptions: [{ text: 'a', known: true }], wontTouch: ['x'], doneWhen: 'npm test', question: { text: 'which?', options: ['a', 'b'] } }
  assert.ok(scoreConfidence(c) < 80)
})

test('no assumptions at all is not certainty', () => {
  assert.equal(scoreConfidence({ assumptions: [], wontTouch: [], doneWhen: 'npm test' }), 50)
})

// Review Focus 1
test('a malformed reply still yields a charter carrying the request', () => {
  for (const raw of [null, undefined, 'not json', 42, [], {}]) {
    const c = coerceCharter(raw, 'add a split command')
    assert.equal(c.request, 'add a split command')
    assert.equal(c.understood, 'add a split command')
    assert.ok(c.confidence < 80, `${JSON.stringify(raw)} should not read as confident`)
    assert.deepEqual(c.assumptions, [])
  }
})

test('an assumption claiming known without citing evidence is downgraded to a guess', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'tests are in test/', known: true }], doneWhen: 'npm test' }, 'r')
  assert.equal(c.assumptions[0]?.known, false)
})

// Review Focus 4
test('an empty done-when is absent rather than an empty command', () => {
  const c = coerceCharter({ understood: 'u', doneWhen: '   ' }, 'r')
  assert.equal(c.doneWhen, '')
})

test('the brief the Lead gets carries the exclusions and the check', () => {
  const b = charterBrief(coerceCharter({ understood: 'Add a split subcommand', wontTouch: ['src/renderer/'], doneWhen: 'npm test' }, 'r'))
  assert.match(b, /Add a split subcommand/)
  assert.match(b, /src\/renderer\//)
  assert.match(b, /npm test/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts`
Expected: FAIL — cannot find module `src/shared/charter`.

- [ ] **Step 3: Write `src/shared/charter.ts`**

`coerceCharter` follows the defensive shape of `coerceOption` in `src/renderer/src/voice/helm/helm.ts` — clamp every string, drop anything of the wrong type, never throw. An assumption is `known` only when its `from` is a non-empty string; the producer in Task 4 is what verifies `from` actually exists.

`scoreConfidence`, exactly: `known / (known + guess)` as a percentage, rounded; `50` when there are no assumptions; then capped at `60` when `doneWhen` is empty, `70` when a `question` is present, and `10` lower when `wontTouch` is empty. Clamp to `0..100`.

`charterBrief` returns the text posted to the Lead — understood, then the assumptions, then `Do not touch: …` and `Done when: …` when those are set. One paragraph, no markdown, since it is typed into a terminal.

- [ ] **Step 4: Run them and watch them pass**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/charter.ts test/unit/charter.test.ts
git commit -m "A charter is what the job was agreed to be"
```

---

### Task 2: "Won't touch" is checked before a merge

**Files:**
- Modify: `src/shared/mergeReview.ts`
- Modify: `src/main/fleet.ts` (the `fleet_merge` case, around line 808)
- Test: `test/unit/merge-review.test.ts`

**Interfaces:**
- Consumes: `Charter` (Task 1).
- Produces:
  ```ts
  /** the wontTouch entry this file matches, or null */
  export function excludedBy(file: string, wontTouch: string[] | undefined): string | null
  // FileFlag gains:  excluded?: string
  // MergeReview gains:  blocked: boolean   // a flag with `excluded` set
  ```

`excludedBy` lives beside `ownedBy` so it shares `norm` and the exact/folder/trailing-star matching, including that function's `ponytail:` note about globbing.

- [ ] **Step 1: Write the failing tests**

```ts
// Review Focus 2
test('an empty exclusion list excludes nothing', () => {
  assert.equal(excludedBy('src/main/pty.ts', []), null)
  assert.equal(excludedBy('src/main/pty.ts', undefined), null)
  assert.equal(excludedBy('src/main/pty.ts', ['']), null)
})

// Review Focus 3
test('exclusions match however the model wrote the path', () => {
  for (const pattern of ['src/renderer', 'src/renderer/', './src/renderer', 'src\\renderer', 'src/renderer/*']) {
    assert.ok(excludedBy('src/renderer/src/App.tsx', [pattern]), `${pattern} should match`)
  }
})

test('an exclusion matches a file, a folder and a star prefix, and nothing outside them', () => {
  assert.equal(excludedBy('src/main/pty.ts', ['src/main/pty.ts']), 'src/main/pty.ts')
  assert.equal(excludedBy('src/mainframe/x.ts', ['src/main/']), null)
})

test('an excluded file is flagged with its exclusion and blocks the review', () => {
  // build fleet state the way the existing tests in this file do, with one merged worker
  // whose diff touches src/renderer/src/App.tsx, and a charter excluding src/renderer/
  assert.equal(review.blocked, true)
  assert.equal(review.flags.find((f) => f.path === 'src/renderer/src/App.tsx')?.excluded, 'src/renderer/')
  assert.equal(review.clean, false)
})

test('a merely sensitive file does not block', () => {
  assert.equal(review.blocked, false)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/merge-review.test.ts`
Expected: FAIL — `excludedBy` is not exported.

- [ ] **Step 3: Implement `excludedBy`, and thread it through `reviewReady`**

`reviewReady(s: FleetState)` keeps its signature and reads `s.charter?.wontTouch` itself — Task 3 puts the charter on the state, so nothing new has to be threaded in. It sets `excluded` on each matching flag. Exclusion-flagged files sort before out-of-scope ones, which already sort before merely sensitive ones. `blocked` is `flags.some((f) => f.excluded)`.

- [ ] **Step 4: Make `fleet_merge` refuse**

In `src/main/fleet.ts`, the `fleet_merge` case currently merges and then reports the stat. Before merging, diff the worker's branch against the Lead's integration branch and, for any path `excludedBy` matches, `fail` with the path and the exclusion it hit, telling the Lead to have the worker revert it. The merge must not be attempted, so the Lead's worktree is left untouched.

- [ ] **Step 5: Run the suite**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/merge-review.test.ts test/unit/fleet-roles.test.ts`
Expected: PASS, including the existing merge-review tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/shared/mergeReview.ts src/main/fleet.ts test/unit/merge-review.test.ts
git commit -m "A file the charter put out of bounds cannot be merged"
```

---

### Task 3: The Lead receives the charter, not the request

**Files:**
- Modify: `src/main/fleet.ts` — `startLead` (line 480), `leadPrompt` (~260), `briefFor` (~292)
- Modify: `src/shared/fleet.ts` — `FleetState.charter?: Charter`
- Test: `test/unit/fleet-roles.test.ts`

**Interfaces:**
- Consumes: `charterBrief`, `Charter` (Task 1).
- Produces: `startLead(opts: { …; charter?: Charter })`. When `charter` is given it is stored on the state and its brief is what gets posted. `opts.goal` stays for callers that have no charter yet, so existing boards and the recovery path in `src/main/fleet.ts:1022` keep working.

- [ ] **Step 1: Write the failing tests**

```ts
test('the lead is briefed from the charter when there is one', () => {
  // startLead with a charter whose understood is "Add a split subcommand"
  const goalMsg = state.messages.find((m) => m.kind === 'goal')
  assert.match(goalMsg.text, /Add a split subcommand/)
  assert.match(goalMsg.text, /Done when/)
})

test('without a charter the lead still gets the raw goal', () => {
  assert.equal(goalMsg.text, 'get to green')
})

test('the charter is kept on the fleet state for the ready card to check', () => {
  assert.equal(state.charter?.understood, 'Add a split subcommand')
})

test('the lead is told the exclusions are not its to change', () => {
  assert.match(leadPrompt(member), /fleet_ask_user/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/fleet-roles.test.ts`
Expected: FAIL — `startLead` takes no `charter`.

- [ ] **Step 3: Store the charter and post its brief**

`startLead` sets `s.charter` and posts `charterBrief(charter)` in place of `opts.goal` in the existing `post(s, { from: 'user', to: id, kind: 'goal', text: … })`.

- [ ] **Step 4: Add one rule to `leadPrompt`, and the exclusions to `briefFor`**

The new Lead rule: the charter's understood, won't-touch and done-when are the user's and are not the Lead's to reinterpret; if the job looks wrong, use `fleet_ask_user` rather than deciding. `briefFor` appends the charter's exclusions to each worker's brief so a worker knows them without reading the Lead's.

- [ ] **Step 5: Run the suite**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/fleet-roles.test.ts test/unit/merge-review.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/fleet.ts src/shared/fleet.ts test/unit/fleet-roles.test.ts
git commit -m "The Lead works from the charter the user confirmed"
```

---

### Task 4: One model call produces the charter

**Files:**
- Create: `src/renderer/src/fleet/charter.ts`
- Modify: `src/renderer/src/voice/helm/helm.ts` — the prompt's `team` option, and `coerceOption`
- Modify: `test/unit/charter.test.ts`

**Interfaces:**
- Consumes: `coerceCharter`, `scoreConfidence` (Task 1).
- Produces:
  ```ts
  /** CHARTER_FIELDS: the prompt fragment describing the charter's JSON, shared by both producers */
  export const CHARTER_FIELDS: string
  /** draft a charter with its own model call, for a door that never consults Oracle */
  export async function draftCharter(request: string): Promise<Charter>
  /** downgrade any assumption whose `from` does not exist in the repo, then rescore */
  export function verifyEvidence(c: Charter, exists: (p: string) => boolean): Charter
  ```
  `HelmOption` gains `charter?: unknown` — the raw object, coerced at use.

- [ ] **Step 1: Write the failing tests**

```ts
test('an assumption citing a path that is not there becomes a guess, and confidence drops', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [
    { text: 'tests live in test/', known: true, from: 'test/' },
    { text: 'commands are in src/main/cli.ts', known: true, from: 'src/main/cli.ts' }
  ], doneWhen: 'npm test' }, 'r')
  const v = verifyEvidence(c, (p) => p === 'test/')
  assert.equal(v.assumptions[0]?.known, true)
  assert.equal(v.assumptions[1]?.known, false)
  assert.ok(v.confidence < c.confidence)
})

test('the charter prompt fragment is the same text both producers send', () => {
  assert.ok(helmPrompt('x', 'board').includes(CHARTER_FIELDS))
})

test('a team option carrying a charter keeps it through coercion', () => {
  const r = coerceResult({ reply: 'ok', options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'g', charter: { understood: 'u' } }] })
  assert.ok(r.options[0]?.charter)
})

test('a team option can never auto-run, charter or not', () => {
  assert.equal(autoSafe({ kind: 'team', label: 'l', detail: 'd', goal: 'g' }), false)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts`
Expected: FAIL — `verifyEvidence` and `CHARTER_FIELDS` are not exported.

- [ ] **Step 3: Write `CHARTER_FIELDS` and extend the Helm prompt**

One fragment naming the charter's JSON fields and the rules the spec fixes: assumptions cite a path or command in `from` or they are guesses; at most one question; name the ambiguity as one of `scope | acceptance | subject | constraint`; never report a confidence number, because it is computed. Add `"charter": {…}` to the `team` option shape in `helmPrompt`, and pass `charter` through `coerceOption`.

- [ ] **Step 4: Write `draftCharter` and `verifyEvidence`**

`draftCharter` is for the playbook and brainstorm doors: `runCli` with `CHARTER_FIELDS`, then `extractJson` — both already used by `askHelm` in the same way. On any failure it returns `coerceCharter(null, request)`, which the Global Constraints require: a bad reply costs confidence, never the goal. `verifyEvidence` takes an `exists` predicate so it stays pure and testable; the caller builds it from the existing `fs:exists` IPC handler (`src/main/fsops.ts:170`). Note that handler is confined by `allowed()`, so a path outside the project answers false — which is the behaviour wanted here, since something outside the repo is not evidence about it.

- [ ] **Step 5: Run the suite**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts test/unit/planner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/fleet/charter.ts src/renderer/src/voice/helm/helm.ts test/unit/charter.test.ts
git commit -m "The charter rides the pass that was already happening"
```

---

### Task 5: The gate, at the one boundary every door crosses

**Files:**
- Modify: `src/renderer/src/fleet/charter.ts` — the gate and its store
- Modify: `src/renderer/src/engine/fleet.ts` — `sendGoal` (line 47)
- Modify: `src/renderer/src/playbooks/run.ts` — `runPlaybook` (line 45)
- Modify: `src/renderer/src/voice/actions.ts` — the `send` case (line 438)
- Test: `test/unit/charter.test.ts`

**Interfaces:**
- Consumes: `draftCharter`, `verifyEvidence` (Task 4); `activeLead` (`engine/fleet.ts`).
- Produces:
  ```ts
  /** Put a charter up for confirmation. Resolves to the confirmed charter, or null if dismissed. */
  export function openGate(c: Charter): Promise<Charter | null>
  /** Which route a request takes: a new Lead, or a follow-up to the one running. */
  export function gateTarget(lead: FleetMember | undefined): { followUpTo?: string }
  export const useCharter: /* zustand store holding the pending charter */
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// Review Focus 5
test('with a lead running the charter is a follow-up to it, not a new team', () => {
  assert.equal(gateTarget({ id: 'lead-1', name: 'Rowan' } as FleetMember).followUpTo, 'lead-1')
  assert.equal(gateTarget(undefined).followUpTo, undefined)
})

test('a dismissed charter starts nothing', async () => {
  const p = openGate(coerceCharter({ understood: 'u' }, 'r'))
  useCharter.getState().dismiss()
  assert.equal(await p, null)
})

test('a confirmed charter resolves with the edits the user made', async () => {
  const p = openGate(coerceCharter({ understood: 'u' }, 'r'))
  useCharter.getState().edit({ understood: 'what I actually meant' })
  useCharter.getState().confirm()
  assert.equal((await p)?.understood, 'what I actually meant')
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/charter.test.ts`
Expected: FAIL — `openGate` is not exported.

- [ ] **Step 3: Implement the gate**

`openGate` puts the charter in the store and returns a promise the card's buttons settle. Editing replaces fields individually — per the spec, so a later plan can read edits as typed deltas.

- [ ] **Step 4: Route all three doors through it**

- `sendGoal`: draft or accept a charter, gate it, then — exactly as now — `fleet:userMessage` when a Lead is live, else `fleet:startLead` with the charter. The follow-up path must not touch `startLead`, which resets `s.tasks` and `s.ready` (Review Focus 5).
- `runPlaybook`: `draftCharter(pb.brief!(values))`, gate, then `fleet:startLead` with both the charter and the existing `title`.
- `actions.ts` `send`: when a target resolves to a fleet member **and** `a.submit` is true, route through the gate instead of `sendToConsole`. With `submit: false` it types as today — text waiting for Enter is already a glance, which is the line `autoSafe` already draws.

- [ ] **Step 5: Run the suite and the typecheck**

Run: `node scripts/test-unit.mjs && npm run typecheck:strict`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/fleet/charter.ts src/renderer/src/engine/fleet.ts src/renderer/src/playbooks/run.ts src/renderer/src/voice/actions.ts test/unit/charter.test.ts
git commit -m "Every door into the team goes past the charter"
```

---

### Task 6: The card

**Files:**
- Create: `src/renderer/src/fleet/CharterCard.tsx`
- Modify: `src/renderer/src/fleet/inboxModel.ts` — a `charter` item kind
- Modify: `src/renderer/src/fleet/InboxTray.tsx`
- Test: `test/e2e/teams.test.ts`

**Interfaces:**
- Consumes: `useCharter`, `openGate` (Task 5); `FULL_CARD_BELOW` (Task 1).
- Produces: `InboxItem` gains `(Base & { kind: 'charter'; charter: Charter })`, ordered first — nothing blocks the user harder than work that has not started.

- [ ] **Step 1: Write the failing e2e test**

In `test/e2e/teams.test.ts`, following the harness already used there: type a goal into the command bar with the scripted claude from `test/fake-agent/claude.mjs`, and assert that **no console is spawned** until the card's confirm is clicked, then that one is. A second case asserts a goal typed while a Lead is running shows a card that names that Lead.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:e2e -- test/e2e/teams.test.ts`
Expected: FAIL — the console spawns without any confirmation.

- [ ] **Step 3: Add the `charter` item kind**

`charterItem(c)` beside the existing `approvalFor` / `ask` builders, with `who` the target Lead or "New team", `sub` the request clipped, and actions: confirm (primary), each of the question's options when there is one, and dismiss. Give it a `replyTo` so typing in the bar edits `understood` rather than going to Oracle — the same mechanism the `ask` kind already uses.

- [ ] **Step 4: Write `CharterCard.tsx`**

Two renderings off one object, switched on `confidence < FULL_CARD_BELOW`: the full card (understood, assumptions with their `known` / `guess` badge, won't touch, done when, and the one question when present) and the one-line form (understood, clipped, with the done-when command still visible — the spec requires that command never run unseen). Match `InboxTray.tsx` for layout and the existing theme tokens; no new CSS file.

- [ ] **Step 5: Run the suites**

Run: `node scripts/test-unit.mjs && npm run typecheck:strict && npm run test:e2e -- test/e2e/teams.test.ts`
Expected: PASS.

- [ ] **Step 6: Check it by hand in the dev app**

Run: `npm run dev`. Type a vague goal and a precise one; confirm the vague one draws the full card with one question and the precise one draws a single line, that Escape dismisses without starting anything, and that editing `understood` changes what the Lead is briefed with. The spec's own worked example is "add a Split PDF command with tests".

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/fleet/CharterCard.tsx src/renderer/src/fleet/inboxModel.ts src/renderer/src/fleet/InboxTray.tsx test/e2e/teams.test.ts
git commit -m "The charter waits for a glance on the command bar"
```

---

## Self-review

**Spec coverage.** Section 2 (the charter) is Tasks 1, 4, 6. "What the Lead actually receives" is Task 3. "Won't touch is checked at merge" is Task 2. "One team at a time" is Task 5's `gateTarget` plus Task 3 keeping `opts.goal` for the recovery path. Section 3 (where the gate goes), including the third PTY door and the `autoSafe` line, is Task 5. "How many model calls" is Task 4. Sections 1, 4 and 5 are out of scope by the header, and the spec's own deferral of correction-promotion is honoured by Task 5 editing fields individually.

**Gaps I am leaving deliberately.** The phone Inbox (`src/main/remote-page.ts`) renders Inbox items, so a new kind will reach it; approving a charter from a phone is not in this plan's tests and should be checked before the feature is relied on away from the desk. The Ready card does not yet tick the charter line by line — that needs the live done-when runner from plan 3.

**Type consistency.** `Charter`, `CharterAssumption` and `Ambiguity` are defined once in Task 1 and only imported after. `excludedBy(file, wontTouch)` mirrors the existing `ownedBy(file, owns)` argument order. `FULL_CARD_BELOW` is the single threshold, used in Task 6 only.

**Proportion.** Six tasks against a 485-line spec, no function bodies, one algorithm spelled out (the confidence formula) because the signature and tests do not determine it.
