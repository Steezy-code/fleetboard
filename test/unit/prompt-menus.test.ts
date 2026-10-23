// What the Inbox can offer for each real prompt in the recordings: the menu read from the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCast, replay } from '../support/casts'
import type { Prompt } from '../../src/shared/prompt'

const prompts = new Map<string, Prompt | null>()
async function promptAt(file: string, mark: string) {
  if (!prompts.size) {
    for (const f of ['claude-session.cast', 'shell-session.cast', 'gemini-first.cast', 'codex-first.cast', 'codex-session.cast', 'claude-automode.cast', 'gemini-session.cast', 'codex-approval.cast']) {
      for (const m of (await replay(loadCast(f))).marks) prompts.set(`${f}|${m.mark}`, m.prompt)
    }
  }
  assert.ok(prompts.has(`${file}|${mark}`), `no mark "${mark}" in ${file}`)
  return prompts.get(`${file}|${mark}`)!
}

const menu = (p: Prompt | null) => (p?.options ?? []).map((o) => (o.selected ? '* ' : '') + o.label)

test('Claude Code: Bash permission', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: bash permission')
  assert.equal(p?.kind, 'menu')
  assert.equal(p?.question, 'Do you want to proceed?')
  assert.deepEqual(menu(p), [
    '* Yes',
    'Yes, and always allow access to /tmp/claude-0/s/demo2 from this project',
    'Yes, and switch to auto mode · auto mode handles these prompts for you',
    'No'
  ])
})

test('Claude Code: file write permission, a wrapped option joined back together', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: edit permission')
  assert.equal(p?.question, 'Do you want to create notes.txt?')
  assert.deepEqual(menu(p), ['* Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)', 'No'])
})

test('Claude Code: AskUserQuestion, with descriptions and an option below a rule', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: ask question')
  assert.equal(p?.question, 'Do you prefer tea or coffee?')
  assert.deepEqual(menu(p), ['* Tea', 'Coffee', 'Type something.', 'Chat about this'])
  assert.equal(p?.options?.[0].detail, 'You prefer tea.')
})

test('Claude Code: unnumbered menus (folder trust, theme)', async () => {
  assert.deepEqual(menu(await promptAt('claude-session.cast', 'needs-you: trust folder')), ['* No, exit', 'Yes, I trust this folder'])
  const theme = await promptAt('claude-session.cast', 'needs-you: theme picker')
  assert.equal(theme?.options?.length, 7)
  assert.deepEqual(menu(theme).slice(0, 2), ['Auto (match terminal)', '* Dark mode'])
})

test('Claude Code: "Press Enter to continue"', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: security notes')
  assert.equal(p?.kind, 'enter')
})

test('Gemini: menus in a frame, below a numbered tips list', async () => {
  const trust = await promptAt('gemini-first.cast', 'needs-you: trust folder')
  assert.equal(trust?.question, 'Do you trust the files in this folder?')
  assert.deepEqual(menu(trust), ['* Trust folder (demo2)', 'Trust parent folder (s)', "Don't trust"])
  const auth = await promptAt('gemini-first.cast', 'needs-you: auth method, second option')
  assert.equal(auth?.question, 'How would you like to authenticate for this project?')
  assert.deepEqual(menu(auth), ['Sign in with Google', '* Use Gemini API Key', 'Vertex AI'])
})

test('Gemini: shell approval, with the command in a nested frame', async () => {
  const p = await promptAt('gemini-session.cast', 'needs-you: shell approval')
  assert.equal(p?.question, 'Allow execution of [Shell]?')
  assert.deepEqual(menu(p), ['* Allow once', 'Allow for this session', 'No, suggest changes (esc)'])
  const card = approvalFor(p)
  assert.match(card?.detail ?? '', /touch made-by-gemini\.txt/)
  assert.deepEqual(card?.options.map((o) => o.tone), ['allow', 'always', 'deny'])
})

test('Codex: command approval; the Inbox card shows the command', async () => {
  const p = await promptAt('codex-approval.cast', 'needs-you: command approval')
  assert.deepEqual(menu(p), [
    '* Yes, proceed (y)',
    "Yes, and don't ask again for commands that start with `touch made-by-codex.txt` (p)",
    'No, and tell Codex what to do differently (esc)'
  ])
  const card = approvalFor(p)
  assert.match(card?.detail ?? '', /Would you like to run the following command\?/)
  assert.match(card?.detail ?? '', /\$ touch made-by-codex\.txt/)
  assert.doesNotMatch(card?.detail ?? '', /please run the command|Press enter/, 'not the conversation above, not key hints')
  assert.deepEqual(buttons(card), ['Allow once [allow]', 'Always allow `touch made-by-codex.txt` [always]', 'No, and tell Codex what to do differently [deny]'])
})

test('Codex: options separated by blank lines, with descriptions', async () => {
  const p = await promptAt('codex-first.cast', 'needs-you: sign in')
  assert.deepEqual(menu(p), ['* Sign in with ChatGPT', 'Sign in with Device Code', 'Provide your own API key'])
  assert.equal(p?.options?.[2].detail, 'Pay for what you use')
  assert.equal((await promptAt('codex-first.cast', 'needs-you: api key'))?.kind, 'enter')
})

test('Claude Code: "make auto mode your default?" is a question for the user, never answered by typing', async () => {
  const p = await promptAt('claude-automode.cast', 'needs-you: make auto mode the default?')
  assert.equal(p?.question, 'Make auto mode your default permission mode?')
  assert.deepEqual(menu(p), ['* Yes, set auto mode as my default permission mode', 'No, keep manual mode'])
  assert.deepEqual(answerKeys(p, { option: 'No, keep manual mode' }), ['\x1b[B', '\r'])
})

test('Codex: folder trust, answered from the Inbox', async () => {
  const p = await promptAt('codex-session.cast', 'needs-you: trust folder')
  assert.deepEqual(menu(p), ['* Trust and continue', 'Quit'])
  const card = approvalFor(p)
  assert.deepEqual(buttons(card), ['Trust and continue [allow]', 'Quit [deny]'])
  assert.deepEqual(answerKeys(p, { option: 'Trust and continue' }), ['\r'])
  assert.deepEqual(answerKeys(p, { option: 'Quit' }), ['\x1b[B', '\r'])
})

test('shell: y/n questions and a password', async () => {
  const yn = await promptAt('shell-session.cast', 'needs-you: y/n question')
  assert.deepEqual([yn?.kind, yn?.question], ['yes-no', 'Overwrite config? [y/N]'])
  assert.equal((await promptAt('shell-session.cast', 'needs-you: printf question'))?.kind, 'yes-no')
  assert.equal((await promptAt('shell-session.cast', 'needs-you: password'))?.kind, 'input')
})

// ------------------------------------------------------------------ answering

import '../support/renderer-env'
import { answerKeys } from '../../src/main/status'
import { approvalFor, seenOf } from '../../src/shared/approvals'

const DOWN = '\x1b[B'
const UP = '\x1b[A'

test('answerKeys: move from the selected option to the chosen one, then Enter', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: bash permission')
  assert.deepEqual(answerKeys(p, { option: 'Yes' }), ['\r'])
  assert.deepEqual(answerKeys(p, { option: 'No' }), [DOWN, DOWN, DOWN, '\r'])
  assert.deepEqual(answerKeys(p, { option: 'No' }, true), ['\x1bOB', '\x1bOB', '\x1bOB', '\r'], 'application cursor keys')
  const auth = await promptAt('gemini-first.cast', 'needs-you: auth method, second option')
  assert.deepEqual(answerKeys(auth, { option: 'Sign in with Google' }), [UP, '\r'])
  const trust = await promptAt('claude-session.cast', 'needs-you: trust folder')
  assert.deepEqual(answerKeys(trust, { option: 'Yes, I trust this folder' }), [DOWN, '\r'])
})

test('answerKeys: refuses when the prompt is gone or is another question', async () => {
  const p = await promptAt('claude-session.cast', 'needs-you: bash permission')
  assert.deepEqual(answerKeys(null, { option: 'Yes' }), { ok: false, reason: 'gone' })
  assert.deepEqual(answerKeys(p, { option: 'Tea' }), { ok: false, reason: 'changed' })
  assert.deepEqual(answerKeys(p, { yes: true }), { ok: false, reason: 'changed' })
  assert.deepEqual(answerKeys(p, { enter: true }), { ok: false, reason: 'changed' })
  const yn = await promptAt('shell-session.cast', 'needs-you: y/n question')
  assert.deepEqual(answerKeys(yn, { yes: false }), ['n', '\r'])
  assert.deepEqual(answerKeys(await promptAt('claude-session.cast', 'needs-you: security notes'), { enter: true }), ['\r'])
  assert.deepEqual(answerKeys(await promptAt('shell-session.cast', 'needs-you: password'), { enter: true }), { ok: false, reason: 'changed' })
})

const buttons = (a: ReturnType<typeof approvalFor>) => a?.options.map((o) => `${o.label} [${o.tone}]`)

test('Inbox cards: Claude Code permissions', async () => {
  const bash = approvalFor(await promptAt('claude-session.cast', 'needs-you: bash permission'))
  assert.equal(bash?.title, 'Do you want to proceed?')
  assert.equal(bash?.detail, 'Bash command\nCreate empty file made-by-bash.txt\ntouch made-by-bash.txt')
  assert.deepEqual(buttons(bash), ['Allow once [allow]', 'Always allow (this project) [always]', 'Deny [deny]'], 'auto mode is not offered')
  const edit = approvalFor(await promptAt('claude-session.cast', 'needs-you: edit permission'))
  assert.equal(edit?.detail, 'Create file\nnotes.txt\n1 hello')
  assert.deepEqual(buttons(edit), ['Allow once [allow]', 'Allow all edits this session [always]', 'Deny [deny]'])
  const trust = approvalFor(await promptAt('claude-session.cast', 'needs-you: trust folder'))
  assert.deepEqual(buttons(trust), ['Trust folder [allow]', 'No, close agent [deny]'])
  assert.equal((trust?.options[0].answer as { option: string }).option, 'Yes, I trust this folder')
  // and marked with the card it is on, so it answers that card and nothing that replaces it
  assert.equal(trust?.options[0].answer.seen, seenOf(trust!))
})

test('Inbox cards: questions keep their own words and order', async () => {
  const q = approvalFor(await promptAt('claude-session.cast', 'needs-you: ask question'))
  assert.equal(q?.title, 'Do you prefer tea or coffee?')
  assert.deepEqual(buttons(q), ['Tea [other]', 'Coffee [other]', 'Chat about this [other]'], '"Type something" needs the console')
  const auth = approvalFor(await promptAt('gemini-first.cast', 'needs-you: auth method'))
  assert.deepEqual(buttons(auth), ['Sign in with Google [other]', 'Use Gemini API Key [other]', 'Vertex AI [other]'])
})

test('Inbox cards: yes/no, Enter, and prompts only the console can answer', async () => {
  assert.deepEqual(buttons(approvalFor(await promptAt('shell-session.cast', 'needs-you: y/n question'))), ['Yes [allow]', 'No [deny]'])
  assert.deepEqual(buttons(approvalFor(await promptAt('claude-session.cast', 'needs-you: security notes'))), ['Continue [allow]'])
  assert.equal(approvalFor(await promptAt('shell-session.cast', 'needs-you: password')), null)
  assert.equal(approvalFor(null), null)
})
