import type { LucideIcon } from 'lucide-react'
import { Boxes, Component, GitFork, ListOrdered, Network, RefreshCcw, Route, Send, Waypoints, Workflow } from 'lucide-react'
import type { DiagramSpec } from './spec'

export interface ProjectDiagram {
  id: string
  label: string
  icon: LucideIcon
  brief: string
}

export const PROJECT_DIAGRAMS: ProjectDiagram[] = [
  {
    id: 'architecture',
    label: 'Architecture',
    icon: Boxes,
    brief:
      'the high-level architecture: runtimes/processes, the major modules inside each, storage, and external services or tools it talks to. Use groups for layers or processes (e.g. "Main process", "Renderer", "Storage", "External"). Edges show dependencies or calls, labeled with the mechanism (IPC, HTTP, import, spawn, ...).'
  },
  {
    id: 'userflow',
    label: 'User flow',
    icon: Route,
    brief:
      'the main user journey through the product, from first launch to the core outcome: screens and actions as rects, decisions as diamonds (edges labeled "yes"/"no" or with the choice), start and end as ellipses. Base it on the actual UI code and routes.'
  },
  {
    id: 'dataflow',
    label: 'Data flow',
    icon: Waypoints,
    brief:
      'how data moves through the system: sources (user input, files, network, devices), transformations, stores and sinks. Edge labels name the data that flows (e.g. "keystrokes", "JSON project", "PNG"). Group by where it runs.'
  },
  {
    id: 'components',
    label: 'Components',
    icon: Component,
    brief:
      'the component structure: the main UI components or modules and what contains or renders what (parent → child). Use groups for areas of the app. Sub lines name the file.'
  },
  {
    id: 'request',
    label: 'Request lifecycle',
    icon: Send,
    brief:
      'the lifecycle of one representative request or action, end to end: what triggers it, every layer it passes through, side effects, and how the result gets back. Edges are labeled with the call, message or event at each hop, in order.'
  },
  {
    id: 'state',
    label: 'State flow',
    icon: RefreshCcw,
    brief:
      'the most important state machine or lifecycle in the code (e.g. a session, job, connection or document): states as rects, the initial and terminal states as ellipses, guards or branching checks as diamonds; edges labeled with the event or condition that causes the transition.'
  }
]

export function buildDiagramPrompt(opts: { brief?: string; describe?: string; projectName: string }): string {
  const what = opts.describe
    ? `a diagram of: "${opts.describe.trim()}". Ground it in this repository where it relates to the code; otherwise use your knowledge.`
    : `a diagram of ${opts.brief}`
  return `You are drawing ${what}

The repository is in the current working directory (folder "${opts.projectName}"). First explore it with your read-only tools (Read, Grep, Glob, LS, git log) so every box corresponds to something real. Do not modify any files.

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{
  "title": "Short title of the diagram",
  "nodes": [ { "id": "short_id", "label": "Name", "sub": "optional detail, e.g. src/main/pty.ts", "shape": "rect", "group": "optional_group_id" } ],
  "edges": [ { "from": "short_id", "to": "other_id", "label": "optional verb" } ],
  "groups": [ { "id": "optional_group_id", "label": "Group name" } ]
}

Rules:
- 7 to 16 nodes. Labels at most 4 words; "sub" at most 6 words (a file path or short detail) and only where it helps.
- "shape" is "rect" for components/steps/states, "ellipse" for start/end points, actors and external systems, "diamond" for decisions.
- ids are unique snake_case; every edge references existing ids. Edges point in the direction of flow or dependency. Edge labels at most 3 words.
- Groups are optional (at most 5); each node belongs to at most one group. Omit "groups" if they do not help.
- Keep it readable: prefer a clear main path with few crossing edges over completeness.`
}

export interface StarterShape {
  id: string
  label: string
  icon: LucideIcon
  spec: DiagramSpec
}

export const STARTERS: StarterShape[] = [
  {
    id: 'flow',
    label: 'Flow',
    icon: Workflow,
    spec: {
      title: 'Flow',
      nodes: [
        { id: 'start', label: 'Start', shape: 'ellipse' },
        { id: 'input', label: 'Collect input', shape: 'rect' },
        { id: 'process', label: 'Process', sub: 'transform and validate', shape: 'rect' },
        { id: 'store', label: 'Save result', shape: 'rect' },
        { id: 'end', label: 'Done', shape: 'ellipse' }
      ],
      edges: [
        { from: 'start', to: 'input' },
        { from: 'input', to: 'process' },
        { from: 'process', to: 'store' },
        { from: 'store', to: 'end' }
      ]
    }
  },
  {
    id: 'steps',
    label: 'Steps',
    icon: ListOrdered,
    spec: {
      title: 'Steps',
      layout: 'LR',
      nodes: [
        { id: 's1', label: '1 · Discover', sub: 'understand the problem', shape: 'rect' },
        { id: 's2', label: '2 · Define', sub: 'agree on scope', shape: 'rect' },
        { id: 's3', label: '3 · Build', sub: 'ship in small slices', shape: 'rect' },
        { id: 's4', label: '4 · Launch', sub: 'measure and learn', shape: 'rect' }
      ],
      edges: [
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3' },
        { from: 's3', to: 's4' }
      ]
    }
  },
  {
    id: 'decision',
    label: 'Decision branch',
    icon: GitFork,
    spec: {
      title: 'Decision',
      nodes: [
        { id: 'start', label: 'Request arrives', shape: 'ellipse' },
        { id: 'check', label: 'Is it valid?', shape: 'diamond' },
        { id: 'yes', label: 'Handle it', shape: 'rect' },
        { id: 'no', label: 'Reject with reason', shape: 'rect' },
        { id: 'end', label: 'Respond', shape: 'ellipse' }
      ],
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'yes', label: 'yes' },
        { from: 'check', to: 'no', label: 'no' },
        { from: 'yes', to: 'end' },
        { from: 'no', to: 'end' }
      ]
    }
  },
  {
    id: 'mindmap',
    label: 'Mind map',
    icon: Network,
    spec: {
      title: 'Mind map',
      layout: 'radial',
      nodes: [
        { id: 'core', label: 'Central idea', shape: 'ellipse' },
        { id: 'a', label: 'Goals', shape: 'rect' },
        { id: 'a1', label: 'Outcome', shape: 'rect' },
        { id: 'a2', label: 'Metric', shape: 'rect' },
        { id: 'b', label: 'People', shape: 'rect' },
        { id: 'b1', label: 'Users', shape: 'rect' },
        { id: 'c', label: 'Risks', shape: 'rect' },
        { id: 'c1', label: 'Unknowns', shape: 'rect' },
        { id: 'c2', label: 'Dependencies', shape: 'rect' },
        { id: 'd', label: 'Next steps', shape: 'rect' },
        { id: 'd1', label: 'This week', shape: 'rect' }
      ],
      edges: [
        { from: 'core', to: 'a' },
        { from: 'a', to: 'a1' },
        { from: 'a', to: 'a2' },
        { from: 'core', to: 'b' },
        { from: 'b', to: 'b1' },
        { from: 'core', to: 'c' },
        { from: 'c', to: 'c1' },
        { from: 'c', to: 'c2' },
        { from: 'core', to: 'd' },
        { from: 'd', to: 'd1' }
      ]
    }
  }
]
