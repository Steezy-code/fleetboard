# Repo knowledge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fleetboard keeps standing knowledge about each repo — how its checks run, who owns what, its house style, what "done" means there — with the provenance of every fact on show, so a charter can state a fact as `known` with a citation instead of guessing, and Oracle answers from the same facts.

**Architecture:** A `RepoKnowledge` object lives in the project's own state (`project.extras.knowledge`), so it is saved, snapshotted and recovered with the board and an old board simply has none. It is built from two sources that never overwrite each other or the user: a read-only inspection of the repo in the main process (free, deterministic, refreshed whenever it is a few minutes old), and one model pass through the user's own planner CLI, on demand from the panel. Facts are merged by key with a fixed precedence — yours, then read from the repo, then from the readme or inferred — and a fact the user deleted is remembered so a rebuild does not bring it back. Both charter producers are shown the facts; the gate resolves a `fact:<key>` citation against them, and only a fact read from the repo, taken from the readme or written by the user counts as evidence. Every edit the user makes to a charter before confirming it is kept as a typed per-field delta and shown in the panel, never promoted into a fact.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React + zustand, `node:test` + `node:assert/strict` run by `scripts/test-unit.mjs`.

**Spec:** [docs/superpowers/specs/2026-10-21-charter-and-understanding-design.md](../specs/2026-10-21-charter-and-understanding-design.md), section 1 ("Project profile").

**Scope:** This is plan 2 of the three the [charter and gate plan](2026-10-21-charter-and-gate.md) names. It depends on plan 1 (on master) and not on plan 3 (live work, Oracle's ambient line and point-and-ask). Promoting repeated corrections into facts is out, per the spec's "Deliberately deferred": the deltas are kept and shown, nothing reads them yet.

**Naming:** the spec calls it a *project profile*. In code it is **repo knowledge** (`knowledge.ts`, `RepoKnowledge`, `KnowledgeFact`), because `src/main/profiles.ts` already means per-account CLI config directories, and `Profile` is already a type in `src/shared/types.ts`. The panel is titled "Repo knowledge".

## Global Constraints

- Nothing uploaded. The inspection reads local files; the model pass is the user's own CLI, like the planner.
- Linux and Windows both. The inspection is plain `fs` and `path.join`, no shell; every path it records is repo-relative with forward slashes, the form the charter and merge gate use.
- **Never block a goal.** No knowledge, an unreadable repo, a failed or slow inspection, or a CLI that is not signed in each mean fewer facts and more `guess` lines, never an error at the gate. The inspection at the gate is bounded by a timeout.
- **Tokens.** The free inspection runs automatically. The model pass runs only when the user asks for it in the panel — it is never spent on the path of a goal.
- **The user wins.** A fact the user wrote, corrected or confirmed is never overwritten or removed by a rebuild of either kind; a fact the user deleted is not re-added.
- **Provenance is not the model's to claim.** `repo` is set only by the inspection, `you` only by the user. A model fact is `readme` only when it names a doc the inspection found, otherwise `inferred`.
- **An inferred fact is not evidence.** Citing it leaves the assumption a guess until the user confirms the fact — otherwise a model's guess would be laundered into charter confidence through the panel, which is the "fake confidence" anti-goal.
- Existing state must load: a board with no `extras.knowledge`, or a hand-edited one, opens with whatever of it is usable.
- No new dependencies. Comments explain why, not what. Sentence case in UI copy.
- **Running tests.** As plan 1: whole suite `node scripts/test-unit.mjs`; one file `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/<name>.test.ts`.

## Review Focus

Seven things the spec implies that no task's happy path exercises, most likely to bite first. Each has a test in the task that owns the code.

1. **A model claims a fact was read from the repo, or written by the user.** It must be recorded as `inferred`; `readme` only with a doc the inspection found. (Task 1)
2. **A rebuild meets a fact the user corrected or deleted.** The corrected one keeps the user's text and provenance; the deleted one stays gone — by either kind of rebuild. (Task 1)
3. **A charter cites an inferred fact, or a fact that is not there.** Both are guesses. (Task 4)
4. **The model writes the citation's resolved field itself** (`fact` on an assumption) to skip the evidence check. The gate must resolve citations itself and ignore what the model put there. (Task 4)
5. **Old or damaged state.** `extras.knowledge` missing, `null`, a string, or with junk facts inside: the board opens and the panel shows what is usable. (Task 1)
6. **The project changes while a read or a rebuild is in flight.** Its result must not be written into the board that is open now. (Task 3)
7. **Windows paths.** A CODEOWNERS pattern or a source path recorded with `\` would never match what the charter and merge gate compare. (Task 2)

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/shared/knowledge.ts` | Types; `coerceKnowledge`, `coerceLearned`; `mergeFacts`; the user's edits (`editFact`, `confirmFact`, `forgetFact`, `addFact`); `knowledgeBlock` (prompt text); `citable`; `charterDeltas`, `withDeltas`. Pure. |
| Create `src/main/knowledge.ts` | `readRepo(root)`: the read-only inspection. `knowledge:read` IPC, confined to the allowed roots. |
| Modify `src/main/index.ts` | Register it. |
| Create `src/renderer/src/fleet/knowledge.ts` | The renderer's side: `currentKnowledge`, `refreshKnowledge` (the free read), `learnKnowledge` (the model pass), `changeKnowledge` (the user's edits), `recordCharterEdits`. |
| Modify `src/shared/charter.ts` | `CharterAssumption.fact`; `verifyEvidence` resolves `fact:` citations. |
| Modify `src/renderer/src/fleet/charter.ts` | `CHARTER_FIELDS` rule for `fact:`; the draft prompt carries the facts; the gate refreshes and resolves against them; a confirmed charter's edits are recorded. |
| Modify `src/renderer/src/fleet/CharterCard.tsx` | A fact-backed assumption says so. |
| Modify `src/renderer/src/voice/helm/context.ts` | A `KNOWN ABOUT THIS REPO` section. |
| Modify `src/renderer/src/voice/helm/helm.ts` | The panel is one Oracle may open; the charter instruction points at the section. |
| Create `src/renderer/src/panels/KnowledgePanel.tsx` | The panel. |
| Modify `src/renderer/src/panels/registry.tsx`, `chrome/Rails.tsx`, `voice/actions.ts` | Reach it. |
| Modify `src/renderer/src/styles/continuity.css` | Its few rows, beside the memory panel's. |
| Create `test/unit/knowledge.test.ts` | Task 1. |
| Create `test/unit/knowledge-read.test.ts` | Task 2. |
| Create `test/unit/knowledge-charter.test.ts` | Tasks 3–6. |
| Create `test/e2e/knowledge.test.ts` | Task 7. |

`inboxModel.ts` and `InboxTray.tsx` are left alone: an open PR is changing them, and nothing here needs them.

---

### Task 1: The knowledge, its provenance and who wins

**Files:**
- Create: `src/shared/knowledge.ts`
- Test: `test/unit/knowledge.test.ts`

**Interfaces:**
- Consumes: `Charter` (plan 1).
- Produces:
  ```ts
  export type Provenance = 'repo' | 'readme' | 'inferred' | 'you'
  export type Topic = 'checks' | 'ownership' | 'style' | 'done' | 'layout'
  export interface KnowledgeFact {
    /** `topic.slug`, stable across rebuilds: what a rebuild and a citation match on */
    key: string
    topic: Topic
    text: string
    provenance: Provenance
    /** repo-relative file or folder it was read or inferred from */
    source?: string
    /** for a check, the command that runs it */
    command?: string
    at: number
  }
  export type CharterDelta = { at: number; request: string } & (
    | { field: 'understood' | 'doneWhen' | 'question'; before: string; after: string }
    | { field: 'wontTouch' | 'assumptions'; added: string[]; removed: string[] }
  )
  export interface RepoKnowledge {
    facts: KnowledgeFact[]
    /** keys the user deleted; no rebuild re-adds them */
    forgotten: string[]
    deltas: CharterDelta[]
    readAt?: number
    learnedAt?: number
  }
  export function coerceKnowledge(raw: unknown): RepoKnowledge
  export function coerceLearned(raw: unknown, docs: string[], at?: number): KnowledgeFact[]
  export function mergeFacts(k: RepoKnowledge, fresh: KnowledgeFact[], replacing: Provenance[]): RepoKnowledge
  export function editFact(k: RepoKnowledge, key: string, patch: { text?: string; command?: string }, at?: number): RepoKnowledge
  export function confirmFact(k: RepoKnowledge, key: string, at?: number): RepoKnowledge
  export function forgetFact(k: RepoKnowledge, key: string): RepoKnowledge
  export function addFact(k: RepoKnowledge, topic: Topic, text: string, at?: number): RepoKnowledge
  /** a fact an assumption may rest on: not inferred, not forgotten */
  export function citable(k: RepoKnowledge, key: string): KnowledgeFact | undefined
  export function knowledgeBlock(k: RepoKnowledge, max?: number): string
  export function charterDeltas(drafted: Charter, confirmed: Charter, at?: number): CharterDelta[]
  export function withDeltas(k: RepoKnowledge, deltas: CharterDelta[]): RepoKnowledge
  export const PROVENANCE_LABEL: Record<Provenance, string>
  ```

- [x] **Step 1: Write the failing tests**

```ts
// Review Focus 1
test('a model cannot claim a fact was read from the repo or written by the user', () => {
  const facts = coerceLearned({ facts: [
    { topic: 'style', key: 'tabs', text: 'Tabs, not spaces', provenance: 'repo' },
    { topic: 'style', key: 'mine', text: 'Use semicolons', provenance: 'you' }
  ] }, ['README.md'])
  assert.deepEqual(facts.map((f) => f.provenance), ['inferred', 'inferred'])
})

test('a readme fact needs a doc the inspection found', () => {
  const [a, b] = coerceLearned({ facts: [
    { topic: 'done', key: 'changelog', text: 'Every change gets a changelog line', source: 'README.md', fromReadme: true },
    { topic: 'done', key: 'docs', text: 'Docs are updated', source: 'NOTES.md', fromReadme: true }
  ] }, ['README.md'])
  assert.equal(a?.provenance, 'readme')
  assert.equal(b?.provenance, 'inferred')
})

// Review Focus 2
test('a fact you corrected survives a rebuild that read it again', () => { /* editFact, then mergeFacts(['repo']) with the same key */ })
test('a fact you deleted is not brought back by either rebuild', () => { /* forgetFact, then mergeFacts(['repo']) and (['readme','inferred']) */ })
test('a rebuild replaces only its own kind of fact', () => { /* a repo read leaves inferred facts; a model pass leaves repo ones */ })
test('read from the repo outranks the model on the same key', () => {})

// Review Focus 5
test('old or damaged state loads as whatever is usable', () => {
  for (const raw of [undefined, null, 'x', 42, [], { facts: 'no' }, { facts: [null, { key: 'checks.x' }, { key: 'checks.ok', topic: 'checks', text: 't', provenance: 'repo', at: 1 }] }])
    assert.doesNotThrow(() => coerceKnowledge(raw))
  // and only the well-formed fact survives
})

test('an inferred fact is shown to the model but is not citable', () => {})
test('a charter edit is a typed delta per field, and an unedited charter has none', () => {})
test('deltas are kept newest last and capped', () => {})
```

- [x] **Step 2: Run them and watch them fail**

Run: `node --enable-source-maps --import ./test/support/register.mjs --test test/unit/knowledge.test.ts`
Expected: FAIL — cannot find module `src/shared/knowledge`.

- [x] **Step 3: Write `src/shared/knowledge.ts`**

`coerceKnowledge` follows `coerceCharter`'s defensive shape: strings clamped, wrong types dropped, never throws. `coerceLearned` builds the key as `topic.slug(key || text)` and sets provenance by the rule in the Global Constraints.

`mergeFacts`, exactly: drop from `k.facts` every fact whose provenance is in `replacing`; add each fresh fact whose key is not forgotten and not already held at a higher precedence (`you` > `repo` > `readme` = `inferred`); a fresh fact that outranks a held one replaces it. A held `you` fact is therefore never touched.

`editFact` and `confirmFact` turn a fact into `you`, keeping its key and source — that is what makes the next rebuild leave it alone. `forgetFact` removes it and records its key. `addFact` keys a new fact `topic.you-<time>`, which no rebuild produces.

`charterDeltas` compares the charter as the gate first showed it with the one confirmed, one delta per changed field; list fields as added and removed entries rather than before and after, so a later reader can compare like with like across goals.

- [x] **Step 4: Run them and watch them pass**

- [x] **Step 5: Commit** — `git commit -m "Repo knowledge says where each fact came from, and yours win"`

---

### Task 2: Reading the repo, without a model

**Files:**
- Create: `src/main/knowledge.ts`
- Modify: `src/main/index.ts`
- Test: `test/unit/knowledge-read.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RepoReading { facts: KnowledgeFact[]; docs: string[] }
  export function readRepo(root: string, at?: number): RepoReading
  // ipc 'knowledge:read' (root) → RepoReading | null    null outside the allowed roots
  ```

What it reads, every fact `provenance: 'repo'` with its `source`:
- **checks:** the package manager from the lockfile; `package.json` scripts named `test`, `lint`, `typecheck`, `build`, `check`, `format` and their `name:variant`s, as the command that runs them (`npm test`, `pnpm run lint`); `Makefile` targets of the same names; `cargo test`, `go test ./...`, `pytest` from their manifests; the GitHub Actions workflows by file name.
- **layout:** the test folder(s) at the root.
- **ownership:** each `CODEOWNERS` rule (root, `.github/`, `docs/`).
- **style:** `.editorconfig`'s indent, and which formatter and linter configs are present; `tsconfig.json` with `strict`; agent and contributor guides (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`).
- **docs:** the readme and guides that exist, for the model pass to read and for `readme` provenance to be checked against.

Each file is read with a size cap and its own `try`: one unreadable or malformed file costs its own facts and nothing else.

- [x] **Step 1: Write the failing tests** — a temp repo with a pnpm lockfile, scripts, `test/`, a `CODEOWNERS`, an `.editorconfig` and a workflow: the commands are `pnpm test` and `pnpm run lint`, the owner rule is there, every fact is `repo` with a forward-slash source. An empty folder and a malformed `package.json` read as no facts without throwing. (Review Focus 7: a source is never written with `\`.)
- [x] **Step 2: Run them and watch them fail**
- [x] **Step 3: Write `readRepo` and the handler.** The handler answers null for a root outside `allowed()` (`src/main/roots.ts`), as the filesystem handlers do: the renderer names the folder, and nothing else should be read on its say-so.
- [x] **Step 4: Run them and watch them pass**
- [x] **Step 5: Commit** — `git commit -m "How a repo checks itself is read from the repo"`

---

### Task 3: Keeping it with the board

**Files:**
- Create: `src/renderer/src/fleet/knowledge.ts`
- Test: `test/unit/knowledge-charter.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2.
- Produces:
  ```ts
  export function currentKnowledge(): RepoKnowledge
  /** the free read, when the last one is older than READ_EVERY_MS; bounded by READ_TIMEOUT_MS */
  export function refreshKnowledge(force?: boolean): Promise<RepoKnowledge>
  /** the free read, then one model pass through the planner CLI */
  export function learnKnowledge(): { promise: Promise<{ ok: boolean; added: number; error?: string }>; cancel: () => void }
  export function changeKnowledge(f: (k: RepoKnowledge) => RepoKnowledge): void
  export function recordCharterEdits(drafted: Charter, confirmed: Charter): void
  /** an engine (features/fleet.ts): read each board's repo as it opens */
  export function watchKnowledge(): void
  ```

When a board was last read is kept in memory, not on the board: it is this session's freshness, and saving it would make every read a save. `readAt` on the board is the last read that changed something.

- [x] **Step 1: Write the failing tests** — a read lands in `project.extras.knowledge`; a second call within `READ_EVERY_MS` does not read again; a read that never answers gives up at the timeout with the knowledge as it was; (Review Focus 6) a read or a model pass whose project closed or changed meanwhile writes nothing; a model pass that fails keeps the repo facts and says why.
- [x] **Step 2: Run them and watch them fail**
- [x] **Step 3: Write it.** Every write checks the project id it started with. A read that changes nothing does not touch the board, so it costs no save.
- [x] **Step 4: Run them and watch them pass**
- [x] **Step 5: Commit** — `git commit -m "Repo knowledge is kept with the board and read again when stale"`

---

### Task 4: A charter cites what is known

**Files:**
- Modify: `src/shared/charter.ts` — `CharterAssumption.fact`, `verifyEvidence`
- Modify: `src/renderer/src/fleet/charter.ts` — `CHARTER_FIELDS`, `draftPrompt`, `gateCharter`
- Modify: `src/renderer/src/fleet/CharterCard.tsx`
- Test: `test/unit/knowledge-charter.test.ts`

**Interfaces:**
- `CharterAssumption` gains `fact?: string` — the key of the knowledge fact it rests on, set only by the gate.
- `verifyEvidence(c, exists, facts?: RepoKnowledge)`: an assumption whose `from` is `fact:<key>` is known when `citable` finds the key, with `from` the fact's source and `fact` its key; otherwise a guess. A `fact` the model wrote is ignored and the line checked as a path.
- `citeKnownCheck(c, k)`: when the charter's done-when is a check the repo was read to have, and no assumption already rests on that fact, a known assumption says so — which is what makes confidence move with the knowledge even when the model cited nothing.

- [x] **Step 1: Write the failing tests**

```ts
test('an assumption citing a fact read from the repo is known, with the fact as its citation', () => {})
// Review Focus 3
test('citing an inferred fact, or one that is not there, is a guess', () => {})
// Review Focus 4
test('a fact the model wrote on an assumption itself is not believed', () => {})
test('the same request scores higher in a repo whose checks are known', async () => { /* gateCharter with and without knowledge */ })
test('the draft prompt carries the facts, and the fragment says how to cite one', () => {})
test('a goal in a repo with no knowledge still reaches the gate', async () => {})
```

- [x] **Step 2: Run them and watch them fail**
- [x] **Step 3: Implement.** The gate refreshes the knowledge first (bounded; a failure is no knowledge), then `citeKnownCheck`, then `verifyEvidence` with it. The card shows a fact-backed assumption's source, marked as resting on the repo knowledge. `draftCharter` uses the knowledge already on the board rather than reading first: it must start its run, and put its stop button up, at once (the plan-1 tests pin that), and `watchKnowledge` has read the repo when the board opened.
- [x] **Step 4: Run the charter suites** — `test/unit/charter.test.ts`, `charter-gate.test.ts`, `knowledge-charter.test.ts`: PASS, the existing ones unchanged.
- [x] **Step 5: Commit** — `git commit -m "A charter's known lines can rest on what the repo knowledge says"`

---

### Task 5: Oracle reads it too

**Files:**
- Modify: `src/renderer/src/voice/helm/context.ts`
- Modify: `src/renderer/src/voice/helm/helm.ts`
- Test: `test/unit/knowledge-charter.test.ts`

- [x] **Step 1: Write the failing tests** — `boardContext()` contains `KNOWN ABOUT THIS REPO` with each fact's key and provenance, and says so plainly when nothing is known yet; `helmPrompt` lists the panel.
- [x] **Step 2: Run them and watch them fail**
- [x] **Step 3: Implement.** The section is part of the fixed text, ahead of console tails, and capped, so the snapshot stays under its limit. The read runs alongside `git:status` in the same `Promise.all`, so Oracle waits for nothing extra.
- [x] **Step 4: Run them and watch them pass**
- [x] **Step 5: Commit** — `git commit -m "Oracle answers from the repo knowledge"`

---

### Task 6: Every charter edit is kept

**Files:**
- Modify: `src/renderer/src/fleet/charter.ts` — the gate's queue keeps the charter as first shown
- Test: `test/unit/knowledge-charter.test.ts`

- [x] **Step 1: Write the failing tests** — confirming a charter whose `understood` was edited and whose question was answered records one delta per field in the knowledge, with the request; confirming one unedited records nothing; dismissing records nothing.
- [x] **Step 2: Run them and watch them fail**
- [x] **Step 3: Implement.** Recorded at confirm, from the charter as the gate showed it — after evidence was checked and a follow-up's exclusions cleared — so a delta is only ever something the user did.
- [x] **Step 4: Run them and watch them pass**
- [x] **Step 5: Commit** — `git commit -m "Every edit to a charter is kept, field by field"`

---

### Task 7: The panel

**Files:**
- Create: `src/renderer/src/panels/KnowledgePanel.tsx`
- Modify: `src/renderer/src/panels/registry.tsx`, `src/renderer/src/chrome/Rails.tsx`, `src/renderer/src/voice/actions.ts`, `src/renderer/src/voice/helm/helm.ts`, `src/renderer/src/styles/continuity.css`
- Test: `test/e2e/knowledge.test.ts`

The panel groups facts by topic. Every fact shows its provenance and source and can be edited or deleted; an inferred one can also be confirmed as right. A fact can be added by hand. "Rebuild" runs the read and the model pass, saying it is one call to the planner CLI. Below the facts, the charter edits, newest first, each as its field and what changed, with a way to clear them.

- [x] **Step 1: Write the failing e2e test** — open a repo with a `package.json` test script; open the panel; the `npm test` fact is there marked as read from the repo; edit its text; force a read; the edit stands, now marked as yours.
- [x] **Step 2: Run it and watch it fail** — `npm run build && FB_E2E_HEADLESS=1 npm run test:e2e:one -- test/e2e/knowledge.test.ts`
- [x] **Step 3: Write the panel, and reach it from the Tools menu, Oracle's panel list and the spoken panel aliases.** The e2e test reads the knowledge through `window.__fleetboard.knowledge`, beside the `useCharter` handle the charter tests already use.
- [x] **Step 4: Run it and watch it pass**
- [x] **Step 5: Commit** — `git commit -m "The repo knowledge panel: every fact, where it came from, and your edits"`

---

### Task 8: The whole thing

- [x] `npm run typecheck`, `npm run typecheck:strict`, `npm run lint`, `npm test`, and the e2e suite headless (`FB_E2E_HEADLESS=1 npm run test:e2e`): all pass.

---

## Self-review

**Spec coverage.** "Every fact carries its provenance" is Task 1 (the type and who may set each kind) and Task 7 (on screen). "Facts you wrote win" is Task 1's `mergeFacts` precedence and its two tests. "Building it: read-only inspection plus one model pass … never block a goal" is Tasks 2 and 3, with the gate's bounded read in Task 4. "So a charter can state … as a known fact" is Task 4; "Oracle … reads the profile" is Task 5. "Learning from corrections" is Task 6 as far as the spec's deferral allows: kept and shown, not promoted. Storage, left to the builder, is per-project state.

**Decisions made here, open to being overruled.**
- Stored in `project.extras`, not a global keyed by project: it then has the board's snapshots and recovery for free, and an old board loads with none.
- The model pass is never automatic. It costs the user tokens and the free read already gives a charter the checks, which are most of what a charter cites.
- An inferred fact is shown but is not evidence until the user confirms it.
- Deleting a derived fact is remembered, so the repo cannot re-assert what the user rejected. Deleting is the user's argument with the knowledge, and the anti-goal is a profile you cannot argue with.
- `citeKnownCheck` adds one known line when the done-when is a check the repo was read to have. It is the only line the gate writes itself, and only before the user has seen the card.

**Gaps left deliberately.** The memory panel (`MemoryPanel.tsx`) already keeps hand-written cards per repo and has its own scan; it is pushed to consoles on demand and has no provenance. The two are not merged here — that is a product call. Nothing reads the deltas yet.

**Type consistency.** `KnowledgeFact`, `RepoKnowledge`, `Provenance`, `Topic` and `CharterDelta` are defined once in Task 1. `CharterAssumption.fact` is set only by `verifyEvidence`.
