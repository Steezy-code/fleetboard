// Claude Code skills are folders with a SKILL.md, under ~/.claude/skills (personal) and
// <project>/.claude/skills (shared with the repo). The handlers read, write and recursively delete
// folders at a path the renderer names, so the confinement check is the whole safety story.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from '../support/electron-stub'
import { parseFrontmatter } from '../../src/main/skills'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-skills-'))
process.env.FLEETBOARD_HOME = home
const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-claude-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proj-'))
const userSkills = path.join(claudeHome, 'skills')
const projectSkills = path.join(project, '.claude', 'skills')

before(async () => {
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  const skills = await import('../../src/main/skills')
  skills.register({ ipc: ipcMain as never, win: () => null, ptys: null as never, settings: (() => ({})) as never, emit: () => {} })
})

const writeSkill = (root: string, slug: string, body: string) => {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
  return dir
}

test('frontmatter: plain values, quotes, folded and literal blocks', () => {
  assert.deepEqual(parseFrontmatter('---\nname: deploy\ndescription: Ships it\n---\nbody'), { name: 'deploy', description: 'Ships it' })
  assert.deepEqual(parseFrontmatter('---\nname: "quoted"\n---'), { name: 'quoted' })
  // a folded block joins with spaces, a literal block keeps the newlines
  assert.equal(parseFrontmatter('---\ndescription: >\n  one\n  two\n---').description, 'one two')
  assert.equal(parseFrontmatter('---\ndescription: |\n  one\n  two\n---').description, 'one\ntwo')
  // a value on the next line with no marker still folds (what people actually write)
  assert.equal(parseFrontmatter('---\ndescription:\n  wrapped text\n---').description, 'wrapped text')
  // no frontmatter at all, and junk, are simply empty
  assert.deepEqual(parseFrontmatter('# Just a heading'), {})
  assert.deepEqual(parseFrontmatter(''), {})
  assert.deepEqual(parseFrontmatter('---\nnot a pair\n---'), {})
})

test('skills are listed per scope, with the roots they came from', async () => {
  writeSkill(userSkills, 'mine', '---\nname: mine\ndescription: Personal one\n---\n')
  writeSkill(projectSkills, 'shared', '---\nname: shared\ndescription: With the repo\n---\n')
  const d = await ipcMain.invoke('skills:list', project)
  assert.deepEqual(d.user.map((s: { slug: string }) => s.slug), ['mine'])
  assert.deepEqual(d.project.map((s: { slug: string }) => s.slug), ['shared'])
  assert.equal(d.roots.user, userSkills)
  assert.equal(d.roots.project, projectSkills)
  assert.equal(d.user[0].description, 'Personal one')

  // with no project open there are no project skills, and no root for them
  const noProject = await ipcMain.invoke('skills:list')
  assert.deepEqual(noProject.project, [])
  assert.equal(noProject.roots.project, null)

  // a folder with no SKILL.md is not a skill
  fs.mkdirSync(path.join(userSkills, 'not-a-skill'), { recursive: true })
  assert.deepEqual((await ipcMain.invoke('skills:list', project)).user.map((s: { slug: string }) => s.slug), ['mine'])
})

test('reading, writing and deleting stay inside the skills folders', async () => {
  const dir = writeSkill(userSkills, 'editable', '---\nname: editable\ndescription: x\n---\nbefore\n')
  const file = path.join(dir, 'SKILL.md')
  assert.match(await ipcMain.invoke('skills:read', file, project), /before/)
  await ipcMain.invoke('skills:save', file, '---\nname: editable\ndescription: x\n---\nafter\n', project)
  assert.match(fs.readFileSync(file, 'utf8'), /after/)

  // a secret outside the roots is neither readable nor writable
  const secret = path.join(os.homedir(), '.ssh', 'id_ed25519')
  for (const p of [secret, path.join(userSkills, '..', '..', '.claude.json'), '/etc/passwd']) {
    await assert.rejects(() => ipcMain.invoke('skills:read', p, project), /Not a skill file/, `read ${p}`)
    await assert.rejects(() => ipcMain.invoke('skills:save', p, 'x', project), /Not a skill file/, `save ${p}`)
  }

  // delete needs a real skill folder inside the roots
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-victim-'))
  fs.writeFileSync(path.join(victim, 'SKILL.md'), 'looks like one')
  await assert.rejects(() => ipcMain.invoke('skills:delete', victim, project), /Not a skill folder/)
  assert.ok(fs.existsSync(victim), 'a folder outside the roots is left alone')
  // and a folder inside the roots that is not a skill is refused too
  await assert.rejects(() => ipcMain.invoke('skills:delete', path.join(userSkills, 'not-a-skill'), project), /Not a skill folder/)
  // a real one goes
  await ipcMain.invoke('skills:delete', dir, project)
  assert.equal(fs.existsSync(dir), false)
})

test('a project skill is only reachable when that project is the one open', async () => {
  const dir = writeSkill(projectSkills, 'repo-only', '---\nname: repo-only\ndescription: x\n---\n')
  const file = path.join(dir, 'SKILL.md')
  assert.match(await ipcMain.invoke('skills:read', file, project), /repo-only/)
  await assert.rejects(() => ipcMain.invoke('skills:read', file), /Not a skill file/, 'no project open')
})

test('creating a skill writes frontmatter the CLI can read, and never overwrites one', async () => {
  const r = await ipcMain.invoke('skills:create', { scope: 'user', name: 'Split PDF', description: 'Splits a PDF\ninto pages' })
  assert.equal(r.slug, 'split-pdf')
  const text = fs.readFileSync(r.file, 'utf8')
  const fm = parseFrontmatter(text)
  assert.equal(fm.name, 'split-pdf')
  assert.equal(fm.description, 'Splits a PDF into pages', 'newlines are folded out of the description')
  await assert.rejects(() => ipcMain.invoke('skills:create', { scope: 'user', name: 'Split PDF', description: 'again' }), /already exists/)
  await assert.rejects(() => ipcMain.invoke('skills:create', { scope: 'user', name: '  ***  ', description: 'x' }), /Give the skill a name/)
})

test('"Open folder" cannot be pointed at any folder on the machine', async () => {
  // this handler had no check at all, and it creates the path it is given, recursively
  const outside = path.join(os.tmpdir(), 'fb-should-not-exist-' + Date.now())
  await assert.rejects(() => ipcMain.invoke('skills:open', outside, project), /Not a skills folder/)
  assert.equal(fs.existsSync(outside), false, 'and it was not created')

  // what the panel actually opens still works: a skill folder, and the roots themselves
  const dir = writeSkill(userSkills, 'openable', '---\nname: openable\ndescription: x\n---\n')
  await ipcMain.invoke('skills:open', dir, project)
  await ipcMain.invoke('skills:open', userSkills, project)
  await ipcMain.invoke('skills:open', projectSkills, project)
})
