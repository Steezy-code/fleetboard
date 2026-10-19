// Playbooks: one-click presets for work you do regularly. Each one starts a Lead with a carefully
// written brief (and sometimes a tile or two), or opens a built-in tool. Helm suggests them too.

export type PlaybookCategory = 'daily' | 'upkeep' | 'occasional'

export interface PlaybookInput {
  key: string
  label: string
  placeholder?: string
  kind?: 'text' | 'textarea' | 'switch'
  /** default value */
  value?: string
  optional?: boolean
}

export interface Playbook {
  id: string
  name: string
  /** lucide icon name, resolved by the UI */
  icon: string
  category: PlaybookCategory
  /** one line on the card */
  blurb: string
  /** when Helm should pick it (fed to the model) */
  whenToUse: string
  /** team shape shown on the card */
  team: string
  inputs: PlaybookInput[]
  /** built-in tool instead of a team (e.g. the morning sweep panel) */
  panel?: string
  /** the goal handed to the Lead */
  brief?: (inputs: Record<string, string>) => string
  /** extra tiles to place next to the Lead */
  tiles?: (inputs: Record<string, string>) => { type: 'web' | 'console'; data: Record<string, any> }[]
}

const steps = (lines: string[]) => lines.map((l, i) => `${i + 1}) ${l}`).join(' ')

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'ship-feature',
    name: 'Ship a feature → PR',
    icon: 'Rocket',
    category: 'daily',
    blurb: 'Describe it. The team plans, builds, reviews, and hands you a PR-ready branch.',
    whenToUse: 'The user wants new functionality or a change built that touches one or more files and should end up as a pull request.',
    team: 'Lead · 1-4 workers · reviewer',
    inputs: [
      { key: 'feature', label: 'What should it do?', kind: 'textarea', placeholder: 'Add a Split PDF command to the Tools menu that writes one file per page range' },
      { key: 'notes', label: 'Anything to keep in mind?', kind: 'text', optional: true, placeholder: 'Match the existing dialogs; no new dependencies' }
    ],
    brief: (i) =>
      `Playbook "Ship a feature as a PR". Goal: ${i.feature}.${i.notes ? ` Constraints: ${i.notes}.` : ''} ` +
      steps([
        "Read the repo's README, CLAUDE.md/AGENTS.md, PLAN.md and package.json scripts, and find where this belongs.",
        'fleet_plan with 1-4 tasks split by files, so no two workers touch the same file.',
        "One worker per task, with done_when using the repo's own checks (typecheck, tests, build).",
        'Merge each report. Then one reviewer checks the whole diff against the goal and runs every check; route findings back to the owner and re-merge.',
        'fleet_finish with a PR-ready summary: a title line, what changed, how it was verified, and any risks.'
      ]) +
      ' Ask me only for real product decisions.'
  },
  {
    id: 'hotfix',
    name: 'Hotfix',
    icon: 'Siren',
    category: 'daily',
    blurb: 'Paste the bug. Reproduce it, pin it with a failing test, fix it minimally, verify.',
    whenToUse: 'Something is broken (an error, crash, wrong result, regression) and needs a small, safe fix.',
    team: 'Lead · 1 worker · reviewer',
    inputs: [
      { key: 'bug', label: 'What is broken?', kind: 'textarea', placeholder: 'Ledger sync creates a duplicate row when two cells change in the same second' },
      { key: 'where', label: 'Where does it happen?', kind: 'text', optional: true, placeholder: 'src/ledger/sync.ts, the Sync button' }
    ],
    brief: (i) =>
      `Playbook "Hotfix". Bug: ${i.bug}.${i.where ? ` Where: ${i.where}.` : ''} Keep the change minimal. ` +
      steps([
        'One worker reproduces it and writes a failing test that captures it (done_when: the new test fails for the right reason).',
        "The same worker fixes it (done_when: that test and the full test suite pass, plus typecheck).",
        "A reviewer checks the fix is minimal, addresses the root cause, and doesn't break neighbouring code.",
        'fleet_finish with root cause, fix, and the test that proves it.'
      ]) +
      " No refactors and no unrelated changes. If it can't be reproduced, fleet_ask_user with what was tried and what's needed."
  },
  {
    id: 'plan-next',
    name: 'Next PLAN.md item',
    icon: 'ListTodo',
    category: 'daily',
    blurb: 'Reads your plan, proposes the next unchecked item, builds it once you say go.',
    whenToUse: 'The user wants to continue the roadmap, asks what is next, or mentions PLAN.md/TODO/roadmap.',
    team: 'Lead · workers · reviewer',
    inputs: [{ key: 'file', label: 'Plan file', kind: 'text', value: 'PLAN.md' }],
    brief: (i) =>
      `Playbook "Next plan item". ` +
      steps([
        `Read ${i.file || 'PLAN.md'} (fall back to ROADMAP.md or TODO.md) and find the next unfinished item: an unchecked box, or the first open item under the current phase or "Known gaps".`,
        "fleet_ask_user to confirm, with options: that item (short name), the one after it, and \"I'll describe it\".",
        'Plan, delegate, merge, and review as usual.',
        `Last task: a worker marks the item done in ${i.file || 'PLAN.md'}, matching the file's style.`,
        'fleet_finish with what was built and how it was verified.'
      ])
  },
  {
    id: 'morning-sweep',
    name: 'Morning sweep',
    icon: 'Sunrise',
    category: 'daily',
    blurb: 'Read-only check across all your repos: uncommitted work, open PRs, CI, stale branches.',
    whenToUse: 'The user asks what needs attention, wants a status or overview across projects, or starts their day.',
    team: 'Built in · no agents',
    inputs: [],
    panel: 'sweep'
  },
  {
    id: 'get-green',
    name: 'Get to green',
    icon: 'ShieldCheck',
    category: 'upkeep',
    blurb: 'Run every check, split the failures by area, fix until everything passes.',
    whenToUse: 'Typecheck, tests, lint or the build are failing, or the user wants the repo green before shipping.',
    team: 'Lead · worker per failing area · reviewer',
    inputs: [],
    brief: () =>
      `Playbook "Get to green". ` +
      steps([
        "Find the project's checks (package.json scripts like typecheck, test, lint, check:*, build; or Makefile, cargo, pytest).",
        'Have a reviewer run them all read-only and report the failures grouped by area/file.',
        'One worker per failing area (it owns those files), done_when: that check passes.',
        'Merge, then a reviewer reruns every check. Repeat, at most 3 rounds, until all pass.',
        'fleet_finish with before and after.'
      ]) +
      " Never weaken a test to make it pass; if a test itself looks wrong, fleet_ask_user."
  },
  {
    id: 'coverage',
    name: 'Test coverage sweep',
    icon: 'TestTubes',
    category: 'upkeep',
    blurb: 'Finds untested logic, ranks it by risk, gives each module its own test writer.',
    whenToUse: 'The user wants more tests, safer refactors, or asks what is untested.',
    team: 'Lead · worker per module · reviewer',
    inputs: [{ key: 'focus', label: 'Focus on', kind: 'text', optional: true, placeholder: 'the ledger and sync code' }],
    brief: (i) =>
      `Playbook "Test coverage sweep"${i.focus ? `, focused on ${i.focus}` : ''}. ` +
      steps([
        'Find modules with real logic but no tests (compare source files to the test folders).',
        'Rank them by risk: business rules, parsing, money, dates, data writes.',
        'fleet_ask_user: pick from the top 3 (by name) or "All of these".',
        "One worker per module writes focused tests in the repo's existing style; done_when: the new test file passes and typecheck still passes (make sure the test is included by the tsconfig/test config).",
        'A reviewer checks the tests exercise real behaviour, not the mocks.',
        "fleet_finish. Don't change source code; report any bugs the tests uncover instead."
      ])
  },
  {
    id: 'docs-drift',
    name: 'Docs drift check',
    icon: 'BookCheck',
    category: 'upkeep',
    blurb: "Compares README, guides and how-tos against the code and fixes what's stale.",
    whenToUse: 'Docs, README, guides or CLAUDE.md may be out of date, or the user changed behaviour and wants the docs to match.',
    team: 'Lead · worker per doc · reviewer',
    inputs: [],
    brief: () =>
      `Playbook "Docs drift check". ` +
      steps([
        'Compare README, docs/, guides, how-tos and CLAUDE.md/AGENTS.md against the actual code: commands, scripts, config, features, UI wording, paths.',
        'fleet_plan with one task per doc file that has concrete mismatches.',
        'One worker per doc file fixes the docs only, never the code.',
        'A reviewer verifies every changed claim against the code.',
        'fleet_finish listing what was wrong and what changed.'
      ]) +
      ' If the code looks wrong rather than the docs, fleet_ask_user instead of guessing.'
  },
  {
    id: 'db-safety',
    name: 'Database safety pass',
    icon: 'DatabaseZap',
    category: 'upkeep',
    blurb: 'Reviews migrations and RLS, runs the DB checks, flags risks before you merge.',
    whenToUse: 'The user changed migrations, schema, RLS policies or DB access code, or is about to merge DB changes.',
    team: 'Lead · reviewers (read-only)',
    inputs: [{ key: 'since', label: 'Compare against', kind: 'text', value: 'origin/main' }],
    brief: (i) =>
      `Playbook "Database safety pass" (review only). ` +
      steps([
        'Find migrations, RLS policies, and DB access code (supabase/migrations, prisma, drizzle, *.sql, query helpers).',
        `Review what changed since ${i.since || 'origin/main'} (git diff ${i.since || 'origin/main'}...HEAD; if that ref is missing, use the last 10 commits): data loss, locks on big tables, missing or too-broad RLS, non-idempotent migrations, missing indexes, broken rollbacks.`,
        "Use reviewers only, and have them run the repo's DB checks if present (test:rls, check:migrations, test:db).",
        'fleet_finish with risks ranked by severity, each with file:line and a suggested fix.'
      ]) +
      ' Do not change anything unless I say yes to a fix via fleet_ask_user.'
  },
  {
    id: 'pr-review',
    name: 'PR review round',
    icon: 'GitPullRequest',
    category: 'occasional',
    blurb: 'A reviewer per open PR. Verdicts land in your Inbox; nothing is posted to GitHub.',
    whenToUse: 'The user wants open pull requests reviewed or asks about PR status.',
    team: 'Lead · reviewer per PR',
    inputs: [{ key: 'max', label: 'At most', kind: 'text', value: '4' }],
    brief: (i) =>
      `Playbook "PR review round" (review only). ` +
      steps([
        'List open PRs with gh pr list.',
        `For each, at most ${i.max || '4'}, start a reviewer that reads gh pr view N and gh pr diff N, checks the change against its description and the repo's conventions, and runs cheap checks only.`,
        'Each verdict: approve, or changes with concrete points (file:line, what, why).',
        'fleet_finish with one short section per PR.'
      ]) +
      ' Never post comments, approve, or merge on GitHub.'
  },
  {
    id: 'deps',
    name: 'Dependency refresh',
    icon: 'PackageCheck',
    category: 'occasional',
    blurb: 'Patch and minor updates, verified by your checks. Majors are listed, not applied.',
    whenToUse: 'The user wants dependencies updated, mentions npm outdated, security updates or stale packages.',
    team: 'Lead · 1 worker · reviewer',
    inputs: [],
    brief: () =>
      `Playbook "Dependency refresh". ` +
      steps([
        "Run the ecosystem's outdated check (npm outdated, pnpm outdated, cargo outdated, pip list --outdated).",
        'One worker updates patch and minor versions only; done_when: install, typecheck, tests and build pass.',
        'If a package breaks something, revert just that one and note why.',
        'fleet_finish with updated, skipped, and available major versions (not applied).'
      ])
  },
  {
    id: 'ui-polish',
    name: 'UI polish pass',
    icon: 'Paintbrush',
    category: 'occasional',
    blurb: 'Live preview tile next to the team. You point at what bugs you, they refine it.',
    whenToUse: 'The user wants the UI to look or feel better, or talks about layout, spacing, styling or a specific screen.',
    team: 'Lead · 1 worker · live web tile',
    inputs: [
      { key: 'url', label: 'Dev server URL', kind: 'text', value: 'http://localhost:5173' },
      { key: 'area', label: 'Which screen or area?', kind: 'text', optional: true, placeholder: 'the Organize pages grid' },
      { key: 'startServer', label: 'Start the dev server for me (npm run dev)', kind: 'switch', value: '' }
    ],
    brief: (i) =>
      `Playbook "UI polish pass"${i.area ? ` on ${i.area}` : ''}. The user is watching the live app at ${i.url} in a web tile next to you. ` +
      steps([
        'Read the UI code for that area and its design tokens/styles.',
        'fleet_ask_user what bothers them most, with 3 specific guesses as options.',
        "One worker makes a small, focused change using the existing tokens; merge it.",
        'fleet_ask_user to look at the preview: "Keep going", "Undo that", "Done".',
        'Repeat until Done, then fleet_finish with a list of the changes.'
      ]),
    tiles: (i) => [
      { type: 'web', data: { url: i.url || 'http://localhost:5173' } },
      ...(i.startServer ? [{ type: 'console' as const, data: { agentId: 'shell', command: 'npm run dev', name: 'Dev server' } }] : [])
    ]
  }
]

export const playbookById = (id: string) => PLAYBOOKS.find((p) => p.id === id)

export const CATEGORY_LABEL: Record<PlaybookCategory, string> = {
  daily: 'Daily drivers',
  upkeep: 'Keeping things healthy',
  occasional: 'Occasional'
}
