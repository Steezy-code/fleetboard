import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { MainContext } from './context'
import { readRegularText } from './paths'
import { writeText } from './fsops'
import { userEnv } from './env'

// Claude Code skills: folders with a SKILL.md (YAML frontmatter name + description) under
// ~/.claude/skills/ (personal) and <project>/.claude/skills/ (shared with the repo).

export interface SkillInfo {
  name: string
  description: string
  scope: 'user' | 'project'
  dir: string
  file: string
  /** folder name — what /<name> invokes */
  slug: string
  updatedAt: number
  files: number
}

const userRoot = () => path.join(userEnv().CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills')
const projectRoot = (projectPath: string) => path.join(projectPath, '.claude', 'skills')
/** a skill is prose: far more than this is not one */
const MAX_SKILL = 2 * 1024 * 1024

export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = (m[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const [, key, rest = ''] = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? '') ?? []
    if (!key) continue
    let v = rest.trim()
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      // folded / literal block: gather indented lines
      const block: string[] = []
      while (/^\s+/.test(lines[i + 1] ?? '')) block.push((lines[++i] ?? '').trim())
      v = block.join(v.startsWith('|') ? '\n' : ' ')
    }
    out[key] = v.replace(/^["']|["']$/g, '')
  }
  return out
}

function listIn(root: string, scope: SkillInfo['scope']): SkillInfo[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const dir = path.join(root, e.name)
    const file = path.join(dir, 'SKILL.md')
    try {
      const st = fs.statSync(file)
      // a SKILL.md that is a FIFO or a link to /dev/zero would hang the main process here
      const fm = parseFrontmatter(readRegularText(file, MAX_SKILL).slice(0, 8000))
      out.push({
        name: fm.name || e.name,
        description: fm.description || '',
        scope,
        dir,
        file,
        slug: e.name,
        updatedAt: st.mtimeMs,
        files: fs.readdirSync(dir).length
      })
    } catch {
      /* not a skill folder */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

const rootsFor = (projectPath?: string) => [userRoot(), projectPath ? projectRoot(projectPath) : null].filter(Boolean) as string[]

function insideRoots(p: string, projectPath?: string) {
  const r = path.resolve(p)
  return rootsFor(projectPath).some((root) => r.startsWith(path.resolve(root) + path.sep))
}

/** The skills folder itself, which "Open folder" may also reveal (it is created on demand). */
function isRoot(p: string, projectPath?: string) {
  const r = path.resolve(p)
  return rootsFor(projectPath).some((root) => r === path.resolve(root))
}

export function register(ctx: MainContext) {
  const { ipc } = ctx
  ipc.handle('skills:list', (_e, projectPath?: string) => ({
    user: listIn(userRoot(), 'user'),
    project: projectPath ? listIn(projectRoot(projectPath), 'project') : [],
    roots: { user: userRoot(), project: projectPath ? projectRoot(projectPath) : null }
  }))

  ipc.handle('skills:read', (_e, file: string, projectPath?: string) => {
    if (!insideRoots(file, projectPath)) throw new Error('Not a skill file')
    return readRegularText(file, MAX_SKILL)
  })

  ipc.handle('skills:save', (_e, file: string, content: string, projectPath?: string) => {
    if (!insideRoots(file, projectPath)) throw new Error('Not a skill file')
    // through the symlink, keeping CRLF endings and any bytes the editor could not show, atomically
    writeText(file, String(content))
    return true
  })

  ipc.handle(
    'skills:create',
    (_e, req: { scope: 'user' | 'project'; projectPath?: string; name: string; description: string; body?: string }) => {
      const root = req.scope === 'project' && req.projectPath ? projectRoot(req.projectPath) : userRoot()
      const slug = slugify(req.name)
      if (!slug) throw new Error('Give the skill a name')
      const dir = path.join(root, slug)
      if (fs.existsSync(dir)) throw new Error(`A skill named "${slug}" already exists`)
      fs.mkdirSync(dir, { recursive: true })
      const desc = (req.description || '').replace(/\r?\n/g, ' ').trim()
      const body =
        req.body?.trim() ||
        `# ${req.name}\n\n## When to use\n\n${desc || 'Describe when Claude should reach for this skill.'}\n\n## Steps\n\n1. \n2. \n3. \n`
      const content = `---\nname: ${slug}\ndescription: ${JSON.stringify(desc || req.name)}\n---\n\n${body}\n`
      const file = path.join(dir, 'SKILL.md')
      fs.writeFileSync(file, content)
      return { dir, file, slug }
    }
  )

  ipc.handle('skills:delete', (_e, dir: string, projectPath?: string) => {
    if (!insideRoots(dir, projectPath) || !fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('Not a skill folder')
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  })

  // the only handler here that had no check: it took any path and created it, recursively
  ipc.handle('skills:open', (_e, dir: string, projectPath?: string) => {
    if (!insideRoots(dir, projectPath) && !isRoot(dir, projectPath)) throw new Error('Not a skills folder')
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  })
}
