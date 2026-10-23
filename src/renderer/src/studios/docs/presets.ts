import type { LucideIcon } from 'lucide-react'
import { BookOpen, Compass, Database, FileText, Layers, ShieldCheck, Telescope, CodeXml } from 'lucide-react'
import { dayKey } from '@shared/time'

export type Depth = 'quick' | 'balanced' | 'thorough'

export const DEPTHS: { value: Depth; label: string; hint: string; eta: string }[] = [
  { value: 'quick', label: 'Quick', hint: 'Fast skim', eta: '~1 min' },
  { value: 'balanced', label: 'Balanced', hint: 'Main modules', eta: '~2–4 min' },
  { value: 'thorough', label: 'Thorough', hint: 'Deep read', eta: '~5–10 min' }
]

export interface DocPreset {
  id: string
  title: string
  sub: string
  icon: LucideIcon
  /** who the document is written for */
  audience: string
  /** what the document must cover */
  brief: string
  /** one line shown in the empty state */
  blurb: string
}

export const DOC_PRESETS: DocPreset[] = [
  {
    id: 'overview',
    title: 'Project overview',
    sub: 'What this repo is, at a glance',
    icon: Telescope,
    audience: 'someone who has never seen this repository and wants to understand it in five minutes',
    blurb: 'Purpose, features, stack, layout and how to run it, on a single page.',
    brief: `Sections, in order:
## What it is — one tight paragraph: the problem it solves, who it is for, what kind of software it is.
## Key features — a bulleted list of the capabilities that actually exist in the code.
## Tech stack — a table with columns Layer | Technology | Where (file or directory).
## Repository layout — a table with columns Path | Purpose for the top-level directories and the most important files.
## How it runs — processes, entry points and the main moving parts, as a short numbered walk-through.
## Getting started — install, run, test and build commands taken from the manifests and scripts (fenced code blocks).
## Recent activity — what the git history says about where the project is heading (summarize, do not paste the log).
## Where to go next — the three to five files a newcomer should open first, each with one line on why.`
  },
  {
    id: 'onboarding',
    title: 'Onboarding guide',
    sub: 'Get a new contributor productive',
    icon: Compass,
    audience: 'a new contributor joining the project this week who must ship a first change quickly',
    blurb: 'Setup, codebase tour, conventions and a walkthrough of a first change.',
    brief: `Sections, in order:
## Before you start — prerequisites (runtimes, tools, versions) found in the repo.
## Setup — numbered, copy-pasteable steps from clone to a running build.
## Everyday tasks — a table with columns Task | Command | Notes (run, test, lint, build, package, ...).
## Codebase tour — where things live: a table Path | What lives here | Start with (a file), then a few sentences on how the pieces fit.
## Core concepts — the domain vocabulary and the main abstractions a contributor must understand, each with the file that defines it.
## Conventions — naming, file organization, state management, error handling, styling, testing; cite real examples.
## Your first change — a concrete walkthrough of adding a typical feature in this codebase: which files to touch, in order, and why.
## Gotchas — non-obvious traps, platform quirks, generated files, things that are easy to break.
## Further reading — docs and files worth reading next.`
  },
  {
    id: 'architecture',
    title: 'Architecture',
    sub: 'Modules, layers and data flow',
    icon: Layers,
    audience: 'engineers who need a precise mental model of how the system is put together',
    blurb: 'Layers, module responsibilities, runtime model, data flow and key design decisions.',
    brief: `Sections, in order:
## System context — what the system is, what it talks to (users, services, OS, files), and its boundaries.
## Layers and modules — a table with columns Module | Responsibility | Key files | Depends on.
## Runtime model — processes/threads/workers, startup sequence, lifecycles.
## Data flow — pick the two most important flows and walk through each as numbered steps naming the functions and files involved.
## State and persistence — where state lives, how it is stored, loaded, cached and invalidated.
## Interfaces — the contracts between modules (APIs, IPC channels, events, message shapes) as a table Interface | Producer | Consumer | Payload.
## Cross-cutting concerns — configuration, errors, logging, security, performance.
## Design decisions — the notable trade-offs visible in the code and what they buy.
## Extension points — how new features are meant to plug in.
Do not use Mermaid or any other diagram syntax; describe structure with tables and numbered steps.`
  },
  {
    id: 'readme',
    title: 'README',
    sub: 'A polished front page for the repo',
    icon: BookOpen,
    audience: 'visitors landing on the repository page who decide in thirty seconds whether to use it',
    blurb: 'A crisp, accurate front page: pitch, features, quick start, usage and configuration.',
    brief: `Structure:
# <Project name> — followed on the next line by a one-sentence tagline in italics.
Then a short paragraph describing what it does and why it is useful.
## Features — 5–10 bullets, each starting with a bold phrase.
## Quick start — the shortest path to running it (fenced shell block).
## Installation — prerequisites and install steps.
## Usage — the main ways to use it, with examples.
## Configuration — a table Option | Default | Description (environment variables, settings, flags) when any exist.
## Project structure — a compact table Path | Purpose.
## Development — a table Script | What it does, from the manifest.
## Contributing — brief, practical.
## License — from the LICENSE file if present; otherwise state that no license file was found.`
  },
  {
    id: 'api',
    title: 'API reference',
    sub: 'Public surface and how to call it',
    icon: CodeXml,
    audience: 'developers integrating with or extending this code who need exact signatures',
    blurb: 'Every public entry point with signatures, parameters, return values and examples.',
    brief: `First identify which public surfaces exist (exported library functions and classes, HTTP endpoints, CLI commands, IPC channels, events, plugin hooks, configuration files). Then:
## Overview — a table Surface | Kind | Defined in | Notes.
For each surface, a ## section. Inside it:
- a summary table Name | Signature | Description,
- then a ### entry per important item with: a one-line description, a parameters table Name | Type | Required | Description, the return value or response shape, errors it can raise, and a short usage example in a fenced code block.
## Conventions — authentication, error format, naming, versioning and stability notes that apply across the API.
Copy signatures and types exactly as they appear in the source.`
  },
  {
    id: 'datamodel',
    title: 'Data model',
    sub: 'Entities, tables and relationships',
    icon: Database,
    audience: 'engineers working with the stored data, schemas and types',
    blurb: 'Entities, fields, relationships, storage and lifecycle, straight from the schemas.',
    brief: `Sections, in order:
## Storage overview — where data persists (databases, files, local storage, caches), formats, and the files that define the schemas or types.
## Entity catalog — a table Entity | Defined in | Purpose.
## Entities — a ### per entity with a fields table Field | Type | Required | Description, plus notes on defaults and constraints.
## Relationships — a table From | To | Cardinality | Via (foreign key, id field, nesting).
## Lifecycle — how records are created, updated, deleted and migrated; schema versioning.
## Invariants and validation — rules the code enforces, and where.
Use the exact names and types from the code.`
  },
  {
    id: 'security',
    title: 'Security overview',
    sub: 'Threat model, assets, entry points',
    icon: ShieldCheck,
    audience: 'a security reviewer assessing this codebase',
    blurb: 'Assets, trust boundaries, entry points, threats and prioritized recommendations.',
    brief: `Sections, in order:
## Scope and assumptions — what was reviewed and the deployment model assumed.
## Assets — a table Asset | Where it lives | Why it matters (credentials, user data, tokens, local files, ...).
## Trust boundaries and entry points — a table Entry point | Trust level | Input | Handled in (file).
## Threat model — a table Threat | Where | Likelihood | Impact | Existing mitigation (STRIDE categories where useful).
## Secrets and credentials — how they are obtained, stored, transmitted and logged.
## Dependencies and supply chain — notable dependencies, update hygiene, native code, downloads.
## Findings and recommendations — a prioritized table Priority | Finding | File | Recommendation.
Base every finding on code you actually read and cite the file; clearly label anything that is an assumption.`
  }
]

export const CUSTOM_ICON = FileText

export const presetById = (id: string) => DOC_PRESETS.find((p) => p.id === id)

const DEPTH_GUIDE: Record<Depth, string> = {
  quick:
    'Depth: QUICK — a fast skim. Read the README, the manifest files (package.json, pyproject.toml, Cargo.toml, go.mod, ...), the top-level layout and a handful of entry points, then write. Keep it tight: roughly 400–700 words. Merge or drop sections that would be thin.',
  balanced:
    'Depth: BALANCED — read the entry points and the main module of each area before writing. Roughly 900–1600 words, covering every section of the brief.',
  thorough:
    'Depth: THOROUGH — read broadly and deeply: every major module, configuration, scripts, tests, and recent history (git log --oneline -n 40). Be comprehensive: roughly 1800–3500 words, every section in detail, with tables and concrete examples.'
}

export function buildDocPrompt(opts: { preset?: DocPreset; request?: string; depth: Depth; projectName: string }): string {
  const { preset, request, depth, projectName } = opts
  const today = dayKey(Date.now())
  const what = preset ? `a "${preset.title}" document` : 'a document'
  const titleRule = preset
    ? `The very first line must be the title as a level-1 heading: "# ${projectName} — ${preset.title}" (or the project's real name if it differs from the folder name).`
    : 'The very first line must be a fitting, specific title as a level-1 heading ("# ...").'
  const brief = preset
    ? `Document brief — write for ${preset.audience}.\n${preset.brief}`
    : `Document brief — the user asked for:\n"""\n${request?.trim()}\n"""\nChoose the structure that serves this request best (## sections, tables where useful).`

  return `You are writing ${what} about the software repository in the current working directory (folder "${projectName}").

How to work:
- First explore the repository with your read-only tools (Read, Grep, Glob, LS, git log). Ground every statement in files you actually opened. Never invent modules, endpoints, tables, commands or settings; if something is unclear or missing, say so briefly.
- ${DEPTH_GUIDE[depth]}
- Do not modify any files.

What to output:
- Output ONLY the finished document, as a single Markdown document. No preamble, no commentary before or after, no code fence around the whole document.
- ${titleRule}
- Right after the title, write a one-paragraph summary, then this callout (a blockquote):
  > **NOTE** — Generated on ${today} from <what you read: key files and directories, the git history range>. <One sentence on what this document does not cover or could not verify.>
- Use ## for sections and ### for subsections. Use Markdown tables wherever an inventory or comparison reads better as a table. Put commands and code in fenced blocks with a language tag. Refer to files as \`path/to/file\`.
- Plain, precise, confident prose. No marketing fluff, no emojis, no HTML, no diagrams-as-code.

${brief}`
}

/** Keep only the document: drop narration before the first H1 and a fence wrapped around it. */
export function cleanMarkdown(text: string, final = false): string {
  const t = text.replace(/\r/g, '')
  const m = /^#[ \t]+\S/m.exec(t)
  if (!m) return final ? t.trim() : ''
  const before = t.slice(0, m.index)
  let doc = t.slice(m.index)
  const fences = (before.match(/^```/gm) ?? []).length
  if (fences % 2 === 1) doc = doc.replace(/\n```[ \t]*\n*$/, '\n')
  return doc.replace(/\s+$/, '') + '\n'
}

export const titleOf = (md: string) => /^#[ \t]+(.+)$/m.exec(md)?.[1]?.replace(/[*_`]/g, '').trim()

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document'
