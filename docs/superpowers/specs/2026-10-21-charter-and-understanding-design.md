# The charter: one shared understanding, from request to Ready

Design document. Written 2026-10-21 from a brainstorming session with Luke.

## Context and intent

Fleetboard can already run a lot of agents well. What it cannot do is show that it
understood you before it spends twenty minutes acting on a misunderstanding.

Today, in `src/renderer/src/voice/planner.ts:722`, anything that is not a board command
and that Oracle could not route goes straight to the Lead as raw text:

```ts
const lead = await sendGoal(text)
```

Oracle's own `team` route does better — it rewrites the request into a "clear,
self-contained goal" — but that rewritten goal is never shown to you before it fires.
And `src/main/fleet.ts:270` tells the Lead, as rule 7, to ask the user only for real
decisions and make reasonable choices itself otherwise. So the system is deliberately
tuned not to check with you, and the first time you see its interpretation is when the
plan lands — by which point workers are already spawning.

The visibility gap has the same root. `FleetTask` carries a status (`todo | doing |
review | done | blocked`) and nothing else: no timestamps, no estimate, no current
activity. The Lead is told to give one-line progress updates, so progress exists only as
chat text inside a terminal. You can see *that* something is working. You cannot see what
it is doing, how long it has been doing it, or whether that is normal.

And Oracle — which already reads the whole board — only speaks when you type into a box.

Three gaps, one cause: **there is no durable object holding what everyone agreed the job
was.** Every surface re-derives it, and none of them can be checked against it.

This design adds that object and routes the existing features through it.

### The intended outcome

- You never learn an agent misunderstood you by watching it work.
- At any moment you can see what each agent is doing, for how long, and whether that is
  off-track — without reading a terminal.
- All of this gets cheaper the longer you use Fleetboard on a repo, because the standing
  knowledge improves.
- Every one of the above is the same object seen from a different angle, not four features
  that need keeping in sync.

## Goals

1. No team work starts in a repo until the user has glanced at the interpretation.
2. Live progress is measured against that interpretation, not reported independently of it.
3. Standing per-repo knowledge is learned once and reused by every surface that briefs an
   agent.
4. The gate is unavoidable. Every entry point gets it without each one implementing it.
5. Oracle answers from the same sources, including when scoped to a board selection.

## Non-goals

- Replacing the Lead's own planning. The charter says what the job is; `fleet_plan` still
  decides how to break it up.
- Changing how workers, worktrees, merging, review or the Ready card work.
- A new panel for the sake of one. The charter appears where work is already started from.
- Cloud, sync or sharing of any kind. This is local state in `~/.fleetboard`, like
  everything else.

## Anti-goals

These would mean the design failed even if it shipped working:

- **A form.** If the gate ever asks more than one question at a time, it is wrong. The
  charter is something you glance at and press Enter on.
- **Ceremony on small things.** If sending a one-line follow-up to a running Lead costs
  the same friction as starting a new goal, people will route around it.
- **A profile you cannot argue with.** A wrong fact in standing knowledge poisons every
  charter after it. If you cannot see where a fact came from and delete it, this is worse
  than having no profile.
- **Another dashboard.** Visibility that lives in a panel you have to go and open has not
  solved anything. It belongs on the tile.
- **Fake confidence.** A number that is always 90-plus teaches you to ignore it.

## The spine

```
Project profile   standing knowledge, learned once per repo
      |
Charter           what this job is — you confirm it before work starts
      |
Live work         measured against the charter
      |
Ready             the charter with every line checked
      |
Oracle            reads all four, anywhere
```

Each layer reads the one above it. Nothing re-derives what a layer above already knows.

## 1. Project profile

Standing knowledge about one repo: how the checks run, who owns what, house style, what
"done" normally means here.

It exists so that a charter can state "tests live in `test/`, run with `npm test`" as a
**known** fact rather than a guess, and so a Lead does not rediscover the repo from zero
on every goal.

**Every fact carries its provenance** — read from the repo, inferred, taken from the
readme, or corrected by you. This is the single most important property of the profile.
A fact you cannot trace is a fact you cannot argue with, and a wrong one will quietly
degrade every charter built on it. Provenance is shown in the panel, and any fact can be
edited or deleted.

**Facts you wrote win.** A hand-corrected fact is never overwritten by a rebuild. (My
call — see Open questions.)

**Learning from corrections.** When the user edits a charter before starting it, the diff
is kept. A correction made the same way repeatedly becomes a profile fact marked
`you corrected`, and the panel shows which facts were learned this way, with a way to
forget them. This is the mechanism that makes the app feel like it knows *you* rather than
just the repo.

Storage: per project. The repo already has per-project state (`store:loadProject` and
`store:saveProject` in `src/main/store.ts`) and global state (`store:getGlobal`); either is
a reasonable home and the choice is the builder's.

Building it: read-only inspection of the repo plus one model pass. It must be cheap enough
to rebuild on demand and must never block a goal — a goal with no profile yet works, it
just produces a charter with more guesses in it.

## 2. The charter

One object per goal, drafted before any agent starts.

| Field | What it holds |
|---|---|
| Request | the user's own words, verbatim |
| Understood | one or two sentences restating the job |
| Assumptions | each line marked `known` (from the profile) or `guess` |
| Won't touch | paths and areas explicitly out of scope |
| Done when | the check that proves it, as a command where possible |
| Confidence | a number, plus the named ambiguity when it is low |
| Question | at most one, only when confidence is low |

**The gate is unconditional.** Every goal waits for the user to glance at it. This was
Luke's explicit decision: he wants it to wait for him to glance too, not only when the
model judges itself unsure.

**Confidence sets the weight of the card, not whether it stops.** (My call.) At high
confidence the charter renders as one line and Enter starts it — a glance, not a form. At
low confidence it opens to the full card with its one question. This keeps the gate honest
without making every goal cost a form, and it means a confidently-wrong model cannot skip
the gate — the worst it can do is make the card shorter.

**Named ambiguity, not a vague score.** When confidence is low the charter must say which
kind of ambiguity it is — missing scope, missing acceptance criteria, ambiguous subject, or
an unstated constraint — because each of those has a known one-question fix. A bare "70%"
is not actionable; "I don't know which of the two things called `split` you mean" is.

**One question maximum.** If there are two ambiguities, ask about the one with the most
leverage and guess the other, marked as a guess. The user can edit.

**Confidence is derived, not self-reported.** A model asked how confident it is answers
90-plus almost every time, which is precisely the "fake confidence" anti-goal above. So
the model's job is to emit *evidence*, not a score: each assumption line is marked `known`
or `guess`, and `known` must name the profile fact it rests on. Confidence is then computed
from that — the ratio of `guess` to `known` lines, and whether the profile covers the paths
and commands the request names. This makes it a scoring function with its own tests, and it
means a charter cannot claim certainty it has not shown its work for.

**The charter is edited per field, not as prose.** Each field is separately editable. This
is partly usability and partly what makes learning from corrections possible later: an edit
is then a typed delta on a known field rather than a diff between two blobs of text.

**Who may change it after confirmation.** The agreed fields — understood, assumptions,
won't touch, done when — are the user's, and nothing else writes to them. The Lead cannot
amend them; if it believes the job needs redefining, that is a `fleet_ask_user`, which
already exists for exactly this. Only progress fields (done-when results, task state)
are written as work proceeds. Without this rule, "Ready is the charter with every line
checked" means nothing, because the thing being checked could have moved.

The charter persists with the team and the Ready card becomes the charter with each line
checked, rather than a separately composed summary.

### What the Lead actually receives

`startLead` currently ends by posting the raw request to the new Lead:

```ts
post(s, { from: 'user', to: id, kind: 'goal', text: opts.goal })
```

The Lead gets that string and nothing else. **If this stays as it is, the gate is
decoration** — editing the charter's understood line would change nothing about what the
Lead then does. So the charter, not the raw request, is what gets posted, and its
`won't touch` and `done when` reach `leadPrompt`, `workerPrompt` and `briefFor`
(`src/main/fleet.ts`, around lines 258-305).

### "Won't touch" is checked at merge

Luke's decision: the exclusions go into the prompts *and* are checked before work can be
merged. Not full enforcement of what workers may be handed, but not advisory either — a
merge is blocked if an excluded path was touched. This catches the harm rather than trying
to police the intent, and it means the exclusion is real without a rule the model can
decide to ignore.

**This is mostly already built.** `src/shared/mergeReview.ts` exists to hold what the team
did against what it was told to do, read just before the user merges. It has `ownedBy` for
path matching, a `FileFlag` carrying every reason a changed file is worth a second look
(including `outside` — no member was granted it), a `RISKS` list of inherently sensitive
paths, and a `clean` verdict. The charter's exclusions become another reason a file is
flagged, and a hit on them makes the merge refuse rather than merely warn.

Note `ownedBy`'s own `ponytail:` comment: exact, folder-prefix and trailing-star matching
only, no real globbing. If charter exclusions want `src/**/*.ts`, that comment names the
swap and says the callers do not change.

## 3. Where the gate goes

This is the part that makes it one system rather than a fourth feature, and it is where the
current code needs the most care. **There are two doors into the Lead today, not one:**

| Caller | Path |
|---|---|
| `src/renderer/src/engine/fleet.ts:59` | `sendGoal` then `fleet:startLead` |
| `src/renderer/src/playbooks/run.ts:45` | `fleet:startLead` directly, bypassing `sendGoal` |

And `sendGoal` itself has a second mode that is just as much input sent to the Lead: when a
Lead is already running it routes to `fleet:userMessage` instead of starting one.

Everything that gives work to a team passes through one of those three, including:

- the command bar's fallthrough (`planner.ts:722`)
- Oracle's `team` option (`helm.ts:348`)
- a brainstorm idea's *Give to team* (`brainstorm.ts:278`)
- every team playbook (`run.ts:45`)

**The gate belongs at that boundary**, in one place both doors call, so no entry point can
route around it and no new entry point has to remember to. A "give to team" verb later
added to a kanban card or a checklist item then gets the gate for free — which is most of
what makes this cohesive.

Follow-up messages to a running Lead get the gate too, but should be the lightest version
of it: these are usually short corrections and must not cost a form. How light is the
builder's call; the constraint is that a follow-up must not be able to silently redefine
the job.

**There is a third door, through the PTY.** `src/renderer/src/voice/actions.ts:441`
handles the `send` action with `sendToConsole(id, a.text, a.submit)`, writing straight into
a console's terminal — and a Lead *is* a console. So Oracle's `send` option and a typed
`@Lead do X` both reach a Lead without touching `fleet:userMessage`.

The rule that resolves this: **a `send` that submits to a fleet member routes through the
gate; a `send` that only types does not need to**, because `submit: false` leaves the text
sitting in the terminal for the user to press Enter on — which is already a glance, by
construction. Conveniently this is also the line `autoSafe` already draws (see below), so
the two restrictions agree. `actions.ts` therefore needs to recognise fleet-member targets;
it already has `resolveTeam` for the adjacent case.

**`auto` is already structural — correcting an earlier claim in this document.**
`autoSafe` at `src/renderer/src/voice/helm/helm.ts:197` enforces this in code, not by
prompt: panels always, `send` only when `submit === false` and at most six targets,
playbooks only from `AUTO_PLAYBOOKS`, everything else false. `team` already cannot auto-run.
So this section needs no new restriction — only a check that the `send` branch cannot reach
a fleet member with `submit: true`, which the rule above gives it.

### One team at a time

Luke's decision. This resolves the charter's cardinality, which was the first schema
question: **one charter per Lead, and one Lead at a time.**

It also matches the code as it stands. `FleetState` holds a single `tasks` array and a
single `ready`, and `startLead` resets both, so the state is already single-team shaped
despite leads being named "Lead 2". Nothing needs to change to support this; it means not
adding concurrency.

The consequence for the gate: when a Lead is already running, the charter is a follow-up to
*that* Lead and says so. It does not ask "new team or follow-up" — that would be a second
question on a card whose anti-goal forbids one. The user ends a team by merging or
dismissing it, as today.

Worth noting as a known sharp edge rather than something to fix here: `sendGoal` routes
*any* text to the newest live Lead, so an unrelated goal typed while a team is running
becomes a follow-up to work it has nothing to do with. The charter makes this visible — the
card plainly says it is a follow-up to the running Lead — which is a real improvement on the
silent version, without adding concurrency to get there.

## 4. Live work against the charter

What the tile and the team view show while work runs.

- **Current activity, not just status.** Correcting an earlier draft of this document:
  `src/main/status.ts` does **not** already extract activity. Its `detectPrompt` reads only
  the bottom ~26 rows, and only for dialogs and menus; `working` and `idle` come from
  output-chunk timing and Claude Code's hooks via `StatusTracker.decide`. Nothing today
  yields "editing `src/main/pty.ts`", so this is a new parser over each CLI's tool-call
  output lines, not a free extension of an existing one.

  Scope it to Claude Code first, where the hooks already exist and the output shape is
  known, and fall back to plain "working" for any CLI whose output does not parse. **No
  model call for this** — a periodic model call per worker would break the token
  constraint, and a wrong verb is worse than no verb. Note that `cleanTail` in
  `src/renderer/src/voice/helm/context.ts` strips exactly the glyphs Claude Code marks
  these lines with, so the parser needs the stream before that cleaning. The recorded casts
  under `test/fixtures` are the right way to test it.
- **Elapsed time, and a separate stall signal.** `FleetTask` needs `startedAt`. The
  estimate is a field the charter model emits per task, not something accumulated from
  history — a per-repo durations store is several times the work for a feature that would
  then be worthless on a fresh repo.

  **Stall detection does not depend on the estimate.** A worker that has produced no output
  for several minutes is stalled whether or not anyone estimated it, so that is the signal
  that raises an Inbox card. The estimate only colours the elapsed figure ("12 min, est
  5"). Keeping these independent is what lets stall detection work on the first goal in a
  fresh repo, which the constraints require.
- **Live diff per worker.** Worker worktrees are invisible until Ready. A periodic
  `git diff --stat` in each worker's worktree makes the work visible while it happens, so
  Ready confirms rather than reveals.
- **Decision log.** Ask workers, in `workerPrompt`, for one line per real choice they made.
  This is the part actually worth reading afterwards, and it is nearly free.
- **The done-when check, live.** The charter's done-when is a command. Running it
  periodically turns the charter's last line into a progress indicator: "3 failing, down
  from 11". `src/main/goal.ts` already runs exactly this kind of check for loops — a command
  in the project, its exit code read, no model involved — and should be reused rather than
  reimplemented.

  Three things this needs pinning down, because `goal.ts` exists to run *the command the
  user wrote* and here the command is model-authored:

  - **It is always visible.** Even the collapsed one-line charter shows the done-when
    command verbatim. It is one line, so this costs nothing against "a glance, not a form",
    and nothing gets run on a loop in the user's shell that they did not see.
  - **It runs in the Lead's integration worktree**, once, not per worker. That is where
    merged work lands, and it is the only location where "down from 11" compares like with
    like. Running `npm test` in N worker worktrees on an interval is also the expensive
    reading of this, for no extra information.
  - **It only runs while that Lead is working**, and can be switched off. A check with a
    long runtime should not overlap itself.

## 5. Oracle, scoped

Oracle gains no new intelligence here. It gains better inputs and two new ways to be asked.

- **It reads the profile and the charter**, alongside the board snapshot it already builds
  in `src/renderer/src/voice/helm/context.ts`.
- **The ambient line.** One quiet line, surfaced when live work has drifted from its
  charter: over the estimate, silent too long, or a done-when check going the wrong way. It
  must be mostly silent — silence is the whole design problem here, and a line that appears
  constantly is worse than no line. Drift against the charter is the trigger, not a model
  deciding something seems interesting.

  **The sentence is composed locally from the drift signal**, with no model call. The
  trigger already carries everything the sentence needs — which worker, which task, how
  long, against what estimate — and a periodic model call to phrase it would breach the
  token constraint for no gain. It is badged as Oracle because it draws on the same
  sources, not because a model writes it.
- **Point and ask.** With a board selection, the context builder is scoped to the selected
  tiles instead of the whole board. The user selects two consoles and a kanban card, asks
  why it is stuck, and gets an answer about those three things. This needs no new model
  work — only a narrower context.

## How many model calls a goal costs

This matters enough to state plainly, because the obvious implementation doubles the wait
on the most common path. Typing a goal today already spends one headless `claude -p` run:
`planner.ts` calls `askHelm`, which routes, and only falls through to `sendGoal` afterwards.
A charter drafted as a second, separate pass would mean two sequential calls and two waits
before anything starts.

So: **one call per goal, at whichever point first needs it.**

- Through Oracle, the charter is part of the pass that is already happening. Oracle's `team`
  option already rewrites the request into a self-contained goal; it emits the charter's
  fields instead. This extends the Helm JSON contract and `coerceResult` in
  `src/renderer/src/voice/helm/helm.ts`.
- Through a door that never consults Oracle — a playbook, a brainstorm idea — a standalone
  charter pass runs at the gate.

Two call sites, but **one prompt fragment and one validator**, shared. Two producers of one
object is a real cost; paying it buys back a doubled wait on every goal typed into the
command bar, which is the trade worth making.

## Constraints

- Local only. Nothing uploaded. Network traffic stays limited to the agent CLIs, the
  one-time model downloads, and web tiles.
- Linux and Windows both, as first-class. Anything shelling out needs the Windows path (see
  `src/main/platform.ts`).
- The planner CLI runs through the user's own `claude -p`. Every model call here costs them
  tokens, so a charter is one call, not a conversation.
- A goal must still work with no profile, no git repo, or a CLI that is not signed in.
  Degrade to more guesses, never to a blocked goal.
- Existing state must load. `~/.fleetboard` is versioned JSON with snapshots; a board saved
  by today's build has to open in the new one.

## Decided, and by whom

Luke decided:

- All three themes together — confidence checks on input to the Lead, visibility into what
  is happening, and intelligence across more surfaces — as one coherent system rather than
  separate features.
- Every goal waits for a glance. No team work starts unseen.
- "Won't touch" is checked at merge: stated in the prompts, and a merge is refused if an
  excluded path was touched. Not full enforcement of what workers may be handed.
- One team at a time. One charter per Lead, no concurrency added.
- The profile learns from the repo and from his corrections, rather than holding only what
  he writes by hand.

My calls, open to being overruled:

- The name *charter*. `brief` is taken (`briefFor`, and the `brief` message kind).
- Confidence sets the card's weight, not whether it gates.
- Confidence is derived from the assumption lines, not self-reported by the model.
- The gate lives at the shared `startLead` and `userMessage` boundary rather than in each
  caller; a `send` that submits to a fleet member joins it, a `send` that only types does
  not need to.
- The charter, not the raw request, is what the Lead receives.
- The agreed fields are the user's: the Lead cannot amend them, only ask.
- The charter model emits per-task estimates; stall detection is independent of them, so it
  works on a fresh repo.
- Activity parsing is Claude Code first, plain "working" elsewhere, never a model call.
- The done-when command is always visible, runs in the Lead's integration worktree only,
  and only while that Lead works.
- The ambient sentence is composed locally, with no model call.
- One model call per goal: folded into Oracle's pass where there is one, standalone at the
  gate otherwise, sharing one prompt fragment and one validator.
- Provenance on every profile fact; learned corrections visible and individually
  forgettable; hand-written facts survive a rebuild.
- Charter fields are edited individually, which is also what makes correction-learning
  tractable later.

## Deliberately deferred

**Promoting repeated corrections into profile facts.** The mechanism that makes it feel like
it knows *you* is also the one with the least certain design: recognising "the same
correction" across differently-worded goals needs either a model pass per correction, on a
path meant to be cheap, or enough structure to compare typed deltas. Phase one keeps every
charter edit as a typed per-field delta and shows them in the profile panel; promoting them
automatically, and choosing the repetition threshold, comes after there is real data to look
at. Keeping the deltas from day one is what makes that possible without deciding it now.

## Left to the builder

- Where the profile is stored (per-project state versus a global keyed by project id).
- How the profile is built: what is read, how it is refreshed.
- How light the follow-up-message gate is, within the constraint above.
- The charter's exact persisted shape, and whether it lives on `FleetState` or beside it.
- Sampling intervals for the live diff and the done-when check.
- Whether the ambient line reuses the Inbox or gets its own strip.
- The exact confidence formula and its threshold, given the inputs fixed above.
- All visual detail. Mockups from the session cover the charter card, the live view, the
  profile panel and point-and-ask; they are the intent, not a spec.

**Naming:** `src/main/profiles.ts` already exists and means something else entirely — the
per-account CLI config directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). The repo-knowledge
module needs a different name.

## Verification

- A goal typed into the command bar produces a charter and does not start a Lead until it is
  confirmed. The same holds for a playbook, for Oracle's `team` route, and for *Give to
  team* on a brainstorm idea — all four, since the point is that the gate is unavoidable.
- An Oracle `send` option aimed at a Lead with `submit: true` goes through the gate; the
  same option with `submit: false` types into the terminal as it does today.
- The Lead's first message contains the confirmed charter, not the raw request: editing the
  understood line before starting changes what the Lead plans from.
- An ambiguous goal ("fix the split thing") yields low confidence, a named ambiguity and
  exactly one question. A clear goal yields a one-line charter.
- Confidence moves when the evidence moves: the same request against a repo with a profile
  scores higher than against one without, with no change to the prompt.
- A goal typed into the command bar costs one headless model call, not two — measurable in
  the usage panel, which already reads local session logs.
- A goal in a repo with no profile still starts, with more `guess` lines.
- `startedAt` populates. A worker silent for several minutes raises an ambient line and an
  Inbox card **even when nothing estimated it**, which is the fresh-repo case.
- A Codex or Gemini worker whose output does not parse shows "working" rather than a wrong
  verb, and nothing spends a model call to label it.
- A worker that edits a path the charter excluded cannot be merged: `mergeReview` flags the
  file with the exclusion as its reason and `fleet_merge` refuses, naming the path.
- A goal given while a Lead is running produces a charter that says it is a follow-up to
  that Lead, and asks no extra question about it.
- The done-when check runs via the existing `goal.ts` path and its result appears on the
  charter.
- A selection of two consoles plus a card, asked a question, produces an answer that
  mentions only those.
- Existing boards from the previous version open with their consoles and teams intact.
- `npm test` and the strict typecheck pass; e2e under Xvfb still passes.
