import { create } from 'zustand'
import { runCli, uid } from '../../lib/api'
import { useApp } from '../../state/store'
import { buildDocPrompt, cleanMarkdown, presetById, titleOf, type Depth } from './presets'

// Generation state lives outside the modal so a run keeps streaming while the studio is closed
// and is still there when it reopens. Finished documents go to project extras 'documents'.

export interface SavedDoc {
  id: string
  /** preset id, or 'custom' for "Ask for anything" */
  preset: string
  title: string
  markdown: string
  createdAt: number
  agentId?: string
  depth?: Depth
  request?: string
}

export interface DocGen {
  key: string
  preset: string
  title: string
  agentId: string
  depth: Depth
  request?: string
  startedAt: number
  markdown: string
  activity: string
  status: 'running' | 'stopped' | 'error'
  error?: string
  projectId: string
}

interface DocStudioState {
  gens: Record<string, DocGen>
  /** selected list entry: preset id or custom doc id */
  selected: string
  agentId: string | null
  depth: Depth
}

export const useDocStudio = create<DocStudioState>(() => ({ gens: {}, selected: 'overview', agentId: null, depth: 'balanced' }))

const cancels = new Map<string, () => void>()

const patch = (key: string, p: Partial<DocGen>) =>
  useDocStudio.setState((s) => (s.gens[key] ? { gens: { ...s.gens, [key]: { ...s.gens[key], ...p } } } : s))

export const savedDocs = (extras: Record<string, any> | undefined): SavedDoc[] => (Array.isArray(extras?.documents) ? extras!.documents : [])

function saveDoc(projectId: string, doc: SavedDoc) {
  const app = useApp.getState()
  if (app.project?.id !== projectId) {
    app.toast(`“${doc.title}” finished after you switched projects, so it was not saved.`, 'warn')
    return
  }
  const prev = savedDocs(app.project.extras)
  const rest = doc.preset === 'custom' ? prev.filter((d) => d.id !== doc.id) : prev.filter((d) => d.preset !== doc.preset)
  app.setProjectExtra('documents', [doc, ...rest].slice(0, 40))
}

export function removeDoc(id: string) {
  const app = useApp.getState()
  app.setProjectExtra('documents', savedDocs(app.project?.extras).filter((d) => d.id !== id))
}

/** Tidy "Read /abs/repo/src/x.ts" into "Read src/x.ts". */
function prettyActivity(line: string, root: string) {
  const r = root.replace(/[\\/]+$/, '')
  return line.split(r + '/').join('').split(r + '\\').join('').replace(/\s+/g, ' ').trim()
}

export function startDoc(opts: { key: string; preset: string; agentId: string; depth: Depth; request?: string }) {
  const app = useApp.getState()
  const project = app.project
  if (!project) return
  stopDoc(opts.key, true)
  const preset = presetById(opts.preset)
  const title = preset?.title ?? (opts.request ? opts.request.trim().replace(/\s+/g, ' ').slice(0, 64) : 'Custom document')
  const prompt = buildDocPrompt({ preset, request: opts.request, depth: opts.depth, projectName: project.name })

  const gen: DocGen = {
    ...opts,
    title,
    startedAt: Date.now(),
    markdown: '',
    activity: 'Reading the repository…',
    status: 'running',
    projectId: project.id
  }
  useDocStudio.setState((s) => ({ gens: { ...s.gens, [opts.key]: gen } }))

  let raw = ''
  let timer: number | undefined
  let cancelFn: (() => void) | undefined
  const current = () => cancelFn !== undefined && cancels.get(opts.key) === cancelFn
  // Render at most ~10 times a second however fast chunks arrive.
  const flush = () => {
    timer = undefined
    if (current()) patch(opts.key, { markdown: cleanMarkdown(raw) })
  }
  const run = runCli(
    { prompt, cwd: project.path, agentId: opts.agentId },
    (_chunk, all) => {
      raw = all
      if (timer === undefined) timer = window.setTimeout(flush, 100)
    },
    (line) => current() && patch(opts.key, { activity: prettyActivity(line, project.path) })
  )
  cancelFn = run.cancel
  cancels.set(opts.key, cancelFn)

  run.promise
    .then((res) => {
      window.clearTimeout(timer)
      const g = useDocStudio.getState().gens[opts.key]
      if (!g || g.status !== 'running' || !current()) return
      cancels.delete(opts.key)
      // a run that failed partway is not the document: saving it would replace the last good one
      if (res.code !== 0) {
        patch(opts.key, {
          status: 'error',
          markdown: '',
          error: res.text.trim().slice(-700) || `The CLI exited with code ${res.code} before finishing the document.`
        })
        return
      }
      const fromResult = cleanMarkdown(res.text)
      const md = fromResult || cleanMarkdown(raw) || cleanMarkdown(res.text, true)
      if (!titleOf(md)) {
        patch(opts.key, {
          status: 'error',
          markdown: '',
          error: (res.text || raw).trim().slice(-700) || `The CLI exited with code ${res.code} without writing a document.`
        })
        return
      }
      saveDoc(project.id, {
        id: opts.preset === 'custom' ? opts.key : uid('doc'),
        preset: opts.preset,
        title: titleOf(md) ?? title,
        markdown: md,
        createdAt: Date.now(),
        agentId: opts.agentId,
        depth: opts.depth,
        request: opts.request
      })
      useDocStudio.setState((s) => {
        const gens = { ...s.gens }
        delete gens[opts.key]
        return { gens }
      })
    })
    .catch((e) => {
      window.clearTimeout(timer)
      if (!current()) return
      cancels.delete(opts.key)
      patch(opts.key, { status: 'error', error: String(e?.message ?? e) })
    })
}

/** Stop a run. Keeps the partial draft on screen unless `discard`. */
export function stopDoc(key: string, discard = false) {
  const cancel = cancels.get(key)
  cancels.delete(key)
  if (discard) {
    useDocStudio.setState((s) => {
      if (!s.gens[key]) return s
      const gens = { ...s.gens }
      delete gens[key]
      return { gens }
    })
  } else patch(key, { status: 'stopped', activity: 'Stopped' })
  cancel?.()
}

export function dismissGen(key: string) {
  stopDoc(key, true)
}
