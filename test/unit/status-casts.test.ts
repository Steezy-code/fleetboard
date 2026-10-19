// Real sessions recorded with test/tools/record.mjs, replayed through the screen model and status
// tracker. Each mark is named "<expected status>: <what was on screen>".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CASTS, expectedOf, loadCast, replay } from '../support/casts'

const casts = fs.readdirSync(CASTS).filter((f) => f.endsWith('.cast'))

test('there are recordings to replay', () => {
  assert.ok(casts.length >= 5, `found ${casts.length}`)
})

for (const file of casts) {
  for (const ignoreHooks of [false, true]) {
    const cast = loadCast(file)
    const hasHooks = cast.events.some((e) => e.kind === 'h')
    if (ignoreHooks && !hasHooks) continue
    test(`${file}${hasHooks ? (ignoreHooks ? ' (hooks lost: screen and timing only)' : ' (with hooks)') : ''}`, async () => {
      const { marks } = await replay(cast, { ignoreHooks })
      assert.ok(marks.length > 0, 'recording has marks')
      for (const m of marks) {
        assert.equal(m.status, expectedOf(m.mark), `at "${m.mark}" (${(m.at / 1000).toFixed(1)}s)\n${m.screen.filter((l) => l.trim()).slice(-14).join('\n')}`)
      }
    })
  }
}

const sequence = async (file: string) => (await replay(loadCast(file))).timeline.map((t) => t.status)

test('claude session: every change of status is a real one (no flicker)', async () => {
  assert.deepEqual(await sequence('claude-session.cast'), [
    'starting',
    'needs-you', // theme picker, security notes, trust folder (before Claude starts its session)
    'starting',
    'idle',
    'working',
    'needs-you', // Bash permission
    'working',
    'idle',
    'working',
    'needs-you', // file write permission
    'working',
    'idle',
    'working',
    'needs-you', // AskUserQuestion
    'working',
    'idle',
    'working', // sleep 7: no output from the command, Claude's spinner keeps it working
    'idle'
  ])
})

test('claude: prompt-like text in a reply or in the input box never reads as a question', async () => {
  assert.deepEqual(await sequence('claude-adversarial.cast'), ['starting', 'idle', 'working', 'idle'])
})
