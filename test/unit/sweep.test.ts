// The morning sweep reads every repo under ~/code and friends and ranks what needs the user. It is
// the second-largest module in the main process and had no tests: it is read-only, so a mistake here
// does not corrupt anything, it quietly points the user at the wrong repo — or misses the red CI it
// exists to find. These are its pure parts: the git output it parses, and the ranking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FLEETBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sweep-'))
const { parseSlug, parseStatus, nextPlanItem, score, sweepRoots, listRepos } = await import('../../src/main/sweep')
type Repo = Parameters<typeof score>[0]

const repo = (over: Partial<Repo> = {}): Repo =>
  ({
    name: 'r', path: '/tmp/r', known: true, branch: 'main', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, fetched: false, uncommitted: 0, untracked: 0, files: [], dirtySince: null,
    stashes: 0, lastCommit: null, daysSinceCommit: null, defaultBranch: 'main', staleBranches: [],
    staleCount: 0, slug: 'o/r', remoteUrl: 'https://github.com/o/r.git', gh: true, prs: [], ci: null,
    plan: null, score: 0, attention: [], ms: 1, ...over
  }) as Repo

const pr = (over: Record<string, unknown> = {}) => ({ number: 1, title: 't', isDraft: false, reviewDecision: null, url: 'u', ...over }) as never

test('a GitHub slug out of every remote shape people really have', () => {
  for (const [url, want] of [
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo/', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['  https://GitHub.com/Owner/Repo.git  ', 'Owner/Repo'],
    ['https://github.com/owner/repo.with.dots', 'owner/repo.with.dots']
  ] as const) {
    assert.equal(parseSlug(url), want, url)
  }
  // not GitHub, or nothing at all
  for (const url of [null, '', 'https://gitlab.com/owner/repo.git', 'git@bitbucket.org:o/r.git', 'nonsense']) {
    assert.equal(parseSlug(url as string | null), null, String(url))
  }
})

test('git status --porcelain -z: counts, and a rename does not become two files', () => {
  // -z separates records with NUL, and for R/C the original path follows as its own record
  const out = [' M src/a.ts', '?? new.txt', 'R  dst.ts', 'src.ts', 'A  added.ts', 'MM both.ts', '!! ignored.ts', ''].join('\0')
  const r = parseStatus(out)
  assert.deepEqual(r.files.map((f) => f.path), ['src/a.ts', 'new.txt', 'dst.ts', 'added.ts', 'both.ts'])
  assert.equal(r.untracked, 1, 'only ?? is untracked')
  assert.equal(r.tracked, 4, 'and !! is ignored entirely')
  assert.deepEqual(r.files.map((f) => f.code), ['M', '??', 'R', 'A', 'MM'])
  assert.deepEqual(parseStatus(''), { files: [], tracked: 0, untracked: 0 })
})

test('the next plan item: an unchecked box wins, else the first item under a Next heading', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-plan-'))
  const write = (f: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), body)
  }
  assert.equal(nextPlanItem(root), null, 'no plan file at all')

  write('PLAN.md', '# Plan\n\n- [x] shipped\n- [ ] **Add** `split-pdf` tests\n- [ ] later\n')
  assert.deepEqual(nextPlanItem(root), { file: 'PLAN.md', item: 'Add split-pdf tests' }, 'markdown emphasis is stripped')

  // no boxes: fall back to a "Next" or "Known gaps" heading
  write('PLAN.md', '# Plan\n\n## Done\n\n- old thing\n\n## Known gaps\n\n- Wire up the budget\n')
  assert.deepEqual(nextPlanItem(root), { file: 'PLAN.md', item: 'Wire up the budget' })

  // a checked item under that heading is not next
  write('PLAN.md', '## Next\n\n- [x] already done\n- real work\n')
  assert.deepEqual(nextPlanItem(root), { file: 'PLAN.md', item: 'real work' })

  // headings that are not about what is next are ignored
  write('PLAN.md', '## History\n\n- ancient\n')
  assert.equal(nextPlanItem(root), null)

  // PLAN.md wins over ROADMAP.md, and docs/ is searched too
  fs.rmSync(path.join(root, 'PLAN.md'))
  write('ROADMAP.md', '- [ ] from the roadmap\n')
  write('docs/PLAN.md', '- [ ] from docs\n')
  assert.deepEqual(nextPlanItem(root), { file: 'ROADMAP.md', item: 'from the roadmap' })
})

test('ranking: red CI outranks everything, and a clean repo scores zero', () => {
  const clean = repo()
  score(clean)
  assert.equal(clean.score, 0)
  assert.deepEqual(clean.attention, [], 'a clean repo says nothing')

  const red = repo({ ci: { conclusion: 'failure', workflowName: 'CI' } as never })
  score(red)
  assert.equal(red.score, 40)
  assert.match(red.attention[0], /CI failing on main \(CI\)/)

  // a successful run is not a reason to look
  const green = repo({ ci: { conclusion: 'success', workflowName: 'CI' } as never })
  score(green)
  assert.equal(green.score, 0)

  // red CI beats every review state put together
  const reviews = repo({ prs: [pr({ reviewDecision: 'CHANGES_REQUESTED' }), pr({ number: 2 }), pr({ number: 3, reviewDecision: 'APPROVED' })] })
  score(reviews)
  assert.ok(red.score > reviews.score / 2, 'red CI is weighted hardest of the single signals')
  assert.match(reviews.attention.join(' | '), /changes requested/)
  assert.match(reviews.attention.join(' | '), /waiting on review/)
  assert.match(reviews.attention.join(' | '), /approved and ready to merge/)
})

test('ranking: uncommitted work only shouts once it is a day old', () => {
  const fresh = repo({ uncommitted: 3, dirtySince: Date.now() - 60_000 })
  score(fresh)
  assert.equal(fresh.score, 3, 'work in progress right now is not a problem')
  assert.deepEqual(fresh.attention, [])

  const stale = repo({ uncommitted: 3, dirtySince: Date.now() - 3 * 86_400_000 })
  score(stale)
  assert.ok(stale.score >= 18, `stale dirty work is ranked up (${stale.score})`)
  assert.match(stale.attention[0], /3 uncommitted files, untouched for 3d/)

  // a draft PR is neither waiting on review nor ready to merge
  const draft = repo({ prs: [pr({ isDraft: true })] })
  score(draft)
  assert.equal(draft.score, 0)
  assert.deepEqual(draft.attention, [])
})

test('ranking: drift, detached HEAD and a branch with no upstream', () => {
  const behind = repo({ behind: 5, upstream: 'origin/main' })
  score(behind)
  assert.match(behind.attention[0], /Behind origin\/main by 5 commits/)

  const ahead = repo({ ahead: 1 })
  score(ahead)
  assert.match(ahead.attention[0], /1 commit not pushed/, 'singular reads correctly')

  const detached = repo({ detached: true, branch: '', upstream: null })
  score(detached)
  assert.match(detached.attention.join(' '), /Detached HEAD/)

  // a feature branch with no upstream is worth a nudge; the default branch is not
  const noUpstream = repo({ branch: 'feature', upstream: null })
  score(noUpstream)
  assert.match(noUpstream.attention.join(' '), /Branch feature has no upstream/)
  const onDefault = repo({ branch: 'main', upstream: null })
  score(onDefault)
  assert.deepEqual(onDefault.attention, [], 'the default branch without an upstream is normal')
})

test('ranking: a repo it could not read says so rather than looking clean', () => {
  const broken = repo({ error: 'not a git repository' })
  score(broken)
  assert.equal(broken.score, 4)
  assert.match(broken.attention[0], /Couldn't read the repo: not a git repository/)

  const fetchFailed = repo({ fetchError: 'host unreachable' })
  score(fetchFailed)
  assert.match(fetchFailed.attention.join(' '), /Fetch failed: host unreachable/)
})

test('the folders it looks in come from settings, and a configured ~ is expanded when it scans', () => {
  // sweepRoots() hands back what the user configured, tilde and all; listRepos() is what expands it
  const defaults = sweepRoots()
  assert.ok(defaults.length > 0, 'there are defaults')
  assert.ok(defaults.some((r) => r.startsWith('~/')), 'the defaults are written the way a person would')

  // a configured list, with a repo and a plain folder inside it
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-home-'))
  const code = path.join(fakeHome, 'code')
  const aRepo = path.join(code, 'thing')
  fs.mkdirSync(path.join(aRepo, '.git'), { recursive: true })
  fs.writeFileSync(path.join(aRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.mkdirSync(path.join(code, 'just-a-folder'), { recursive: true })
  ;(os as { homedir: () => string }).homedir = () => fakeHome

  fs.writeFileSync(path.join(process.env.FLEETBOARD_HOME!, 'app.json'), JSON.stringify({ global: { sweepRoots: ['~/code'] } }))
  assert.deepEqual(sweepRoots(), ['~/code'], 'read back as configured')

  const { roots, repos } = listRepos()
  assert.deepEqual(roots, ['~/code'])
  assert.deepEqual(repos.map((r) => r.name), ['thing'], 'only the git repo, and the tilde was expanded')
  assert.ok(path.isAbsolute(repos[0].path))

  // a comma-separated string is accepted too (that is how the setting can be typed)
  fs.writeFileSync(path.join(process.env.FLEETBOARD_HOME!, 'app.json'), JSON.stringify({ global: { sweepRoots: '~/code, ~/nowhere' } }))
  assert.deepEqual(sweepRoots(), ['~/code', '~/nowhere'])
  assert.deepEqual(listRepos().repos.map((r) => r.name), ['thing'], 'a root that does not exist is skipped, not an error')

  // an empty setting falls back to the defaults rather than scanning nothing
  fs.writeFileSync(path.join(process.env.FLEETBOARD_HOME!, 'app.json'), JSON.stringify({ global: { sweepRoots: [] } }))
  assert.deepEqual(sweepRoots(), defaults)
})

test("it never sweeps Fleetboard's own folder", () => {
  // ~/.fleetboard holds the team worktrees: a sweep over those would report the agents' own branches
  const fbHome = process.env.FLEETBOARD_HOME!
  const inside = path.join(fbHome, 'worktrees', 'goal-lead')
  fs.mkdirSync(path.join(inside, '.git'), { recursive: true })
  fs.writeFileSync(path.join(inside, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(fbHome, 'app.json'), JSON.stringify({ projects: [{ path: inside }], global: { sweepRoots: [path.join(fbHome, 'worktrees')] } }))
  assert.deepEqual(listRepos().repos, [], "a worktree under ~/.fleetboard is not one of the user's repos")
})
