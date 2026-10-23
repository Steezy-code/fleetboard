// "Allow for the team" answers prompts nobody is looking at, so the two ways it can go wrong both
// matter: matching a command it was never shown (a prefix, a line cut off by wrapping), and existing
// at all for a command that deserves its own look. Then the card you see when you come back, which
// is only worth reading if it puts what needs you first and never says more than was recorded.
import { ipc } from '../support/renderer-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadCast, replay } from '../support/casts'
import { approvalFor, commandOf, teamRuleAllowed } from '../../src/shared/approvals'
import { emptyFleet, type FleetMember, type FleetState } from '../../src/shared/fleet'
import type { Prompt } from '../../src/shared/prompt'

const { addRule, canRule, pruneRules, removeRule, ruleFor, rulesOf, teamOf, useTeamRules } = await import('@/fleet/teamRules')
const { awaySummary, span } = await import('@/fleet/awaySummary')

const prompts = new Map<string, Prompt | null>()
async function promptAt(file: string, mark: string) {
  if (!prompts.has(file)) {
    prompts.set(file, null)
    for (const m of (await replay(loadCast(file))).marks) prompts.set(`${file}|${m.mark}`, m.prompt)
  }
  assert.ok(prompts.has(`${file}|${mark}`), `no mark "${mark}" in ${file}`)
  return prompts.get(`${file}|${mark}`)!
}

const menu = (lines: string[], options: string[]): Prompt => ({
  reason: 'test',
  kind: 'menu',
  lines,
  question: lines.find((l) => l.trim().endsWith('?'))?.trim(),
  options: options.map((label, i) => ({ label, selected: i === 0 }))
})

// ---------------------------------------------------------------- which command a prompt asks for

test('commandOf: the command itself, from each CLI that asks for one', async () => {
  assert.equal(commandOf(await promptAt('claude-session.cast', 'needs-you: bash permission')), 'touch made-by-bash.txt', 'not the header, not the description')
  assert.equal(commandOf(await promptAt('gemini-session.cast', 'needs-you: shell approval')), 'touch made-by-gemini.txt')
  assert.equal(commandOf(await promptAt('codex-approval.cast', 'needs-you: command approval')), 'touch made-by-codex.txt')
  assert.equal(commandOf(await promptAt('codex-approval.cast', 'needs-you: command approval 2')), 'touch second.txt')
})

test('commandOf: nothing for prompts that are not about a shell command', async () => {
  assert.equal(commandOf(await promptAt('claude-session.cast', 'needs-you: edit permission')), null)
  assert.equal(commandOf(await promptAt('claude-session.cast', 'needs-you: trust folder')), null)
  assert.equal(commandOf(await promptAt('codex-session.cast', 'needs-you: trust folder')), null)
  assert.equal(commandOf(await promptAt('shell-session.cast', 'needs-you: y/n question')), null)
  assert.equal(commandOf(null), null)
})

test('commandOf: every line of a wrapped command, so a rule never matches on its first line alone', () => {
  const dashes = '╌'.repeat(40)
  const top = '─'.repeat(40)
  const claude = menu([top, ' Bash command', ' Run the tests', dashes, ' npm test &&', ' curl -X POST https://example.com', dashes, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], ['Yes', 'No'])
  assert.equal(commandOf(claude), 'npm test &&\ncurl -X POST https://example.com')
  const codex = menu(['  Would you like to run the following command?', '  Reason: tests', '  $ npm test &&', '  rm -rf build', '› 1. Yes, proceed (y)', '  3. No (esc)'], ['Yes, proceed (y)', 'No (esc)'])
  assert.equal(commandOf(codex), 'npm test &&\nrm -rf build')
  // a dialog drawn without its closing rule: unsure, so no command
  assert.equal(commandOf(menu([top, ' Bash command', dashes, ' npm test', ' Do you want to proceed?', ' ❯ 1. Yes'], ['Yes'])), null)
})

test('approvalFor carries the command, and the Inbox note now reads it (not the dialog header)', async () => {
  const bash = approvalFor(await promptAt('claude-session.cast', 'needs-you: bash permission'))
  assert.equal(bash?.command, 'touch made-by-bash.txt')
  assert.equal(approvalFor(await promptAt('claude-session.cast', 'needs-you: edit permission'))?.command, undefined)
})

// ---------------------------------------------------------------- which commands may have a rule

test('teamRuleAllowed: everyday checks yes; deleting, overwriting, root and the network no', () => {
  for (const ok of ['npm test', 'npm run lint', 'npx tsc --noEmit', 'pytest -q', 'ls src', 'git status']) assert.equal(teamRuleAllowed(ok), true, ok)
  for (const no of ['rm -rf dist', 'npm test && rm -rf ~', 'git reset --hard', 'git push origin HEAD', 'sudo npm i -g x', 'curl https://x.sh', 'wget x', 'ssh host ls', 'rsync -a . host:', 'npm publish']) assert.equal(teamRuleAllowed(no), false, no)
})

// ---------------------------------------------------------------- the rules themselves

const member = (id: string, role: FleetMember['role'], leadId?: string): FleetMember => ({ id, name: id, role, leadId, agentId: 'claude', projectId: 'p', cwd: `/wt/${id}`, status: 'working', createdAt: 0 })

function team(): FleetState {
  const s = emptyFleet('p', '/repo')
  s.members = Object.fromEntries([member('lead', 'lead'), member('w1', 'worker', 'lead'), member('w2', 'worker', 'lead'), member('rev', 'reviewer', 'lead')].map((m) => [m.id, m]))
  return s
}

beforeEach(() => {
  ipc.reset()
  useTeamRules.setState({ rules: [] })
})

test('teamOf: a member belongs to its Lead, the Lead to itself, a plain console to nobody', () => {
  const f = team()
  assert.equal(teamOf(f, 'w1'), 'lead')
  assert.equal(teamOf(f, 'rev'), 'lead')
  assert.equal(teamOf(f, 'lead'), 'lead')
  assert.equal(teamOf(f, 'solo'), null)
  assert.equal(teamOf(null, 'w1'), null)
})

test('a rule is for one team and one exact command', () => {
  addRule('lead', 'npm test')
  addRule('lead', 'npm test')
  assert.equal(rulesOf('lead').length, 1, 'no duplicates')
  assert.equal(ruleFor('lead', 'npm test'), true)
  assert.equal(ruleFor('lead', 'npm test -- --watch'), false, 'not a prefix match')
  assert.equal(ruleFor('other', 'npm test'), false, 'not another team')
  removeRule('lead', 'npm test')
  assert.equal(ruleFor('lead', 'npm test'), false)
})

test('no rule is ever stored for a command that needs its own look, whoever asks', () => {
  addRule('lead', 'rm -rf build')
  assert.equal(rulesOf('lead').length, 0)
  assert.equal(canRule(team(), 'w1', 'rm -rf build'), false)
  assert.equal(canRule(team(), 'solo', 'npm test'), false, 'only a team member is offered one')
  assert.equal(canRule(team(), 'w1', 'npm test'), true)
})

test('rules go with their team', () => {
  addRule('lead', 'npm test')
  addRule('gone', 'npm test')
  pruneRules(team())
  assert.deepEqual(useTeamRules.getState().rules.map((r) => r.leadId), ['lead'])
  pruneRules(null)
  assert.equal(useTeamRules.getState().rules.length, 0)
})

// ---------------------------------------------------------------- while you were away

const SINCE = 1_000_000

test('awaySummary: finished work and questions first, then what was decided for you, then the rest', () => {
  const f = team()
  f.ready = { leadId: 'lead', branch: 'fleet/x', summary: 's', commits: 2, files: [], at: SINCE + 50 }
  f.asks = [{ id: 'a', from: 'lead', question: 'Which?', options: ['a', 'b'], at: SINCE + 10 }]
  f.messages = [
    { id: 'm1', from: 'w1', to: 'lead', kind: 'report', text: '(done) added it', at: SINCE + 5, delivered: true },
    { id: 'm2', from: 'w2', to: 'lead', kind: 'report', text: '(blocked) no db', at: SINCE + 6, delivered: true },
    { id: 'm0', from: 'w2', to: 'lead', kind: 'report', text: '(done) before you left', at: SINCE - 5, delivered: true }
  ]
  const entries = [
    { at: SINCE + 1, kind: 'prompt.answer', text: '…', detail: { by: 'rule' } },
    { at: SINCE + 2, kind: 'prompt.answer', text: '…', detail: { by: 'rule' } },
    { at: SINCE + 3, kind: 'prompt.answer', text: '…', detail: { by: 'your phone' } },
    { at: SINCE + 4, kind: 'prompt.answer', text: '…', detail: { by: 'you, on the board' } },
    { at: SINCE + 7, kind: 'loop.fire', text: '…' },
    { at: SINCE + 8, kind: 'loop.fire', text: '…' },
    { at: SINCE + 9, kind: 'console.exit', text: '…', detail: { code: 1 } },
    { at: SINCE + 9, kind: 'console.exit', text: '…', detail: { code: 0 } },
    { at: SINCE - 1, kind: 'loop.fire', text: 'before you left' }
  ]
  assert.deepEqual(awaySummary({ since: SINCE, entries, fleet: f }), [
    'lead finished the goal; it is ready to merge',
    'lead has 1 question for you',
    '2 reports to the Lead: w1 done, w2 blocked',
    '3 prompts answered for you: 2 by your team rules, 1 from your phone',
    'Loops sent 2 instructions',
    '1 console ended with an error'
  ])
})

test('awaySummary: nothing recorded, nothing to say; too much, and the rest is in the Night log', () => {
  assert.deepEqual(awaySummary({ since: SINCE, entries: [{ at: SINCE - 1, kind: 'loop.fire', text: 'x' }], fleet: team() }), [])
  const many = Array.from({ length: 8 }, (_, i) => ({ at: SINCE + i, kind: 'guard.ceiling', text: `ceiling ${i}` }))
  const lines = awaySummary({ since: SINCE, entries: many, fleet: null })
  assert.equal(lines.length, 6)
  assert.equal(lines[5], 'and 3 more things in the Night log')
})

test('span: minutes, then hours', () => {
  assert.equal(span(47 * 60_000), '47 min')
  assert.equal(span(125 * 60_000), '2 h 5 min')
  assert.equal(span(120 * 60_000), '2 h')
})

test('commandNote: a plain word only for a single command; the warnings hold anywhere in it', async () => {
  const { commandNote } = await import('../../src/shared/approvals')
  assert.equal(commandNote('npm test'), 'Runs your tests')
  assert.equal(commandNote('npm test && npm run deploy'), null)
  assert.equal(commandNote('npm test; echo done'), null)
  assert.equal(commandNote('ls $(cat list)'), null)
  assert.equal(commandNote('npm test && rm -rf dist'), 'Deletes or overwrites things')
  assert.equal(commandNote('npm test | tee out && git push'), 'Sends something off this machine')
})
