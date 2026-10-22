// Where a charter comes from: the fragment both producers send, Oracle's team option carrying one,
// the standalone draft for a door that never consults Oracle, and the check that its evidence is real.
// And where it goes: the gate every door into the team crosses before anything starts.
import { ipc } from '../support/renderer-env'
import { test, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Charter, FULL_CARD_BELOW, coerceCharter } from '@shared/charter'
import { excludedBy } from '@shared/mergeReview'

const { useApp } = await import('@/state/store')
const { CHARTER_FIELDS, draftCharter, gateCharter, gateTarget, openGate, useCharter, verifyEvidence } = await import('@/fleet/charter')
const { autoSafe, coerceResult, helmPrompt, runHelmOption, useHelm } = await import('@/voice/helm/helm')
const { sendGoal, useFleet } = await import('@/engine/fleet')
const { runPlaybook } = await import('@/playbooks/run')
const { runAction } = await import('@/voice/actions')
const { useThread } = await import('@/voice/thread')

const withProject = () =>
  useApp.setState({ project: { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [] } as any })

beforeEach(() => {
  ipc.reset()
  useApp.setState({ project: null })
})

// ---------------------------------------------------------------- the evidence check

test('an assumption citing a path that is not there becomes a guess, and confidence drops', () => {
  const c = coerceCharter(
    {
      understood: 'u',
      assumptions: [
        { text: 'tests live in test/', known: true, from: 'test/' },
        { text: 'commands are in src/main/cli.ts', known: true, from: 'src/main/cli.ts' }
      ],
      doneWhen: 'npm test'
    },
    'r'
  )
  const v = verifyEvidence(c, (p) => p === 'test/')
  assert.equal(v.assumptions[0]?.known, true)
  assert.equal(v.assumptions[1]?.known, false)
  assert.ok(v.confidence < c.confidence)
})

test('a downgraded assumption is the same shape a guess is, with the citation that failed gone', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'nope/' }] }, 'r')
  assert.deepEqual(verifyEvidence(c, () => false).assumptions, [{ text: 'a', known: false }])
})

test('a charter whose evidence all exists keeps its score, and the one passed in is not changed', () => {
  const c = coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'src/' }], wontTouch: ['x'], doneWhen: 'npm test' }, 'r')
  const before = JSON.stringify(c)
  assert.equal(verifyEvidence(c, () => true).confidence, c.confidence)
  verifyEvidence(c, () => false)
  assert.equal(JSON.stringify(c), before)
})

test('"known" with nothing cited is not evidence, whatever built the charter', () => {
  const c = { ...coerceCharter({ understood: 'u' }, 'r'), assumptions: [{ text: 'a', known: true }] }
  assert.equal(verifyEvidence(c, () => true).assumptions[0]?.known, false)
})

// ---------------------------------------------------------------- the shared fragment

test('the charter prompt fragment is the same text both producers send', async () => {
  assert.ok(helmPrompt('x', 'board').includes(CHARTER_FIELDS))

  withProject()
  const sent: string[] = []
  ipc.handle('cli:run', (req: any) => {
    sent.push(req.prompt)
    return { code: 0, text: '{}' }
  })
  await draftCharter('x')
  assert.ok(sent[0]?.includes(CHARTER_FIELDS))
})

// What the merge gate matches is a path, a folder or a folder/* prefix. Prose or a glob matches
// nothing there and fails open — the card would say something was protected that is not.
test('the fragment asks for wontTouch in the forms the merge gate matches, and says what not to write', () => {
  const rule = CHARTER_FIELDS.split('\n').find((l) => l.startsWith('- wontTouch'))
  assert.ok(rule, 'the fragment has a wontTouch rule')
  for (const [entry, file] of [
    ['package.json', 'package.json'],
    ['src/renderer', 'src/renderer/App.tsx'],
    ['src/renderer/*', 'src/renderer/App.tsx']
  ] as const) {
    assert.ok(rule.includes(`"${entry}"`), `the rule shows ${entry}`)
    assert.equal(excludedBy(file, [entry]), entry, `${entry} really excludes ${file}`)
  }
  assert.match(rule, /glob/i)
  assert.match(rule, /description/i)
  assert.match(rule, /leading slash/i)
})

// The words alone would survive the sentence being turned round to endorse these forms. What makes the
// rule protect anything is that it forbids them, and that the forbidden forms really match nothing.
test('the fragment forbids the forms the merge gate cannot match, and each one really matches nothing', () => {
  const rule = CHARTER_FIELDS.split('\n').find((l) => l.startsWith('- wontTouch'))!
  const forbidAt = rule.search(/never write/i)
  assert.ok(forbidAt >= 0, 'the rule says what never to write')
  assert.match(rule, /match nothing/i)
  assert.match(rule, /protect nothing/i)
  // src/renderer/** is the form a model most often writes; the gate reads it as the prefix "src/renderer/*"
  for (const form of ['the renderer', 'src/renderer/**', 'src/**/*.tsx']) {
    assert.ok(rule.indexOf(`"${form}"`) > forbidAt, `${form} is listed after "never write", not offered as a form to use`)
    assert.equal(excludedBy('src/renderer/App.tsx', [form]), null, `${form} really excludes nothing`)
  }
  assert.match(rule, /single trailing \*/i, 'the only wildcard allowed is stated')
})

test('the fragment tells the model not to report a confidence number, and to ask at most one question', () => {
  assert.match(CHARTER_FIELDS, /confidence/i)
  assert.match(CHARTER_FIELDS, /at most one question/i)
  for (const kind of ['scope', 'acceptance', 'subject', 'constraint']) assert.ok(CHARTER_FIELDS.includes(kind), kind)
})

// ---------------------------------------------------------------- through Oracle

test('a team option carrying a charter keeps it through coercion', () => {
  const r = coerceResult({ reply: 'ok', options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'g', charter: { understood: 'u' } }] })
  assert.ok(r.options[0]?.charter)
  assert.equal(coerceCharter(r.options[0]?.charter, 'req').understood, 'u', 'it is the raw object, coerced where it is used')
})

test('a team option with no charter, or one that is not an object, carries none', () => {
  const r = coerceResult({
    reply: 'ok',
    options: [
      { kind: 'team', label: 'a', detail: 'd', goal: 'g' },
      { kind: 'team', label: 'b', detail: 'd', goal: 'g', charter: 'sure' },
      { kind: 'team', label: 'c', detail: 'd', goal: 'g', charter: ['x'] }
    ]
  })
  assert.equal(r.options.length, 3)
  for (const o of r.options) assert.equal('charter' in o, false)
})

test('a team option can never auto-run, charter or not', () => {
  assert.equal(autoSafe({ kind: 'team', label: 'l', detail: 'd', goal: 'g' }), false)
  assert.equal(autoSafe({ kind: 'team', label: 'l', detail: 'd', goal: 'g', charter: { understood: 'u' } }), false)
  const r = coerceResult({ reply: 'ok', auto: 0, options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'g', charter: { understood: 'u' } }] })
  assert.equal(r.auto, null)
})

// ---------------------------------------------------------------- a door that never consults Oracle

test('draftCharter costs one model call and returns the model\'s charter, coerced', async () => {
  withProject()
  ipc.handle('cli:run', () => ({
    code: 0,
    text: 'Here you go:\n```json\n' + JSON.stringify({ understood: 'Add a --json flag', assumptions: [{ text: 'flags live in cli.ts', known: true, from: 'src/main/cli.ts' }], wontTouch: ['src/renderer/*'], doneWhen: 'npm test', confidence: 99 }) + '\n```'
  }))
  const c = await draftCharter('add a json flag')
  assert.equal(ipc.callsTo('cli:run').length, 1)
  assert.equal(c.request, 'add a json flag')
  assert.equal(c.understood, 'Add a --json flag')
  assert.deepEqual(c.wontTouch, ['src/renderer/*'])
  assert.notEqual(c.confidence, 99, 'a confidence the model reports is not believed')
  assert.equal((ipc.callsTo('cli:run')[0]?.[0] as any).cwd, '/tmp/p', 'it runs in the project, so the model can look at the repo')
  assert.ok((ipc.callsTo('cli:run')[0]?.[0] as any).prompt.includes('"add a json flag"'), 'the request is in the prompt')
})

test('a reply with no JSON, or a CLI that fails, costs confidence and never the goal', async () => {
  withProject()
  const fallback = coerceCharter(null, 'fix the login bug')
  ipc.handle('cli:run', () => ({ code: 0, text: 'I would be happy to help with that.' }))
  assert.deepEqual({ ...(await draftCharter('fix the login bug')), at: 0 }, { ...fallback, at: 0 })
  ipc.handle('cli:run', () => {
    throw new Error('spawn claude ENOENT')
  })
  const failed = await draftCharter('fix the login bug')
  assert.deepEqual({ ...failed, at: 0 }, { ...fallback, at: 0 })
  assert.equal(failed.understood, 'fix the login bug', 'the goal itself comes through')
})

test('with no project open there is nothing to run in, and no call is made', async () => {
  const c = await draftCharter('fix the login bug')
  assert.equal(c.understood, 'fix the login bug')
  assert.equal(ipc.callsTo('cli:run').length, 0)
})

// ---------------------------------------------------------------- the gate

describe('the gate', () => {
  const realConfirm = useApp.getState().confirm
  const lead = { id: 'lead-1', name: 'Rowan', role: 'lead', status: 'working', createdAt: 1 }

  beforeEach(() => {
    while (useCharter.getState().pending) useCharter.getState().dismiss()
    useFleet.setState({ state: null })
    useThread.setState({ entries: [] })
    // a real toast holds the process open for its few seconds
    useApp.setState({ live: {}, confirm: realConfirm, toast: () => {} })
    ipc.handle('fleet:isolation', () => 'worktrees')
    ipc.handle('fleet:startLead', () => ({ id: 'lead-new', name: 'Nova', role: 'lead' }))
    ipc.handle('fleet:userMessage', () => true)
  })

  const withLead = () => {
    useFleet.setState({ state: { members: { [lead.id]: lead } } as any })
    useApp.setState({ live: { [lead.id]: true } })
  }
  /** wait for the card to be put up; a charter that never appears is the failure */
  const cardUp = async (): Promise<Charter> => {
    for (let i = 0; i < 300 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
    const c = useCharter.getState().pending
    assert.ok(c, 'a charter is waiting for the user')
    return c
  }
  const quiet = () => new Promise((r) => setTimeout(r, 25))
  /** for what must not wait on the user: a gate wrongly in the way is a failure, not a hang */
  const promptly = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('it waited on the gate')), 500))])
  const drafts = (reply: object) => ipc.handle('cli:run', () => ({ code: 0, text: JSON.stringify(reply) }))
  const started = () => ipc.callsTo('fleet:startLead').map((a) => a[0] as any)

  // ------------------------------------------------------------ the store

  test('with a lead running the charter is a follow-up to it, not a new team', () => {
    assert.equal(gateTarget({ id: 'lead-1', name: 'Rowan' } as any).followUpTo, 'lead-1')
    assert.equal(gateTarget(undefined).followUpTo, undefined)
  })

  test('a dismissed charter starts nothing', async () => {
    const p = openGate(coerceCharter({ understood: 'u' }, 'r'))
    useCharter.getState().dismiss()
    assert.equal(await p, null)
    assert.equal(useCharter.getState().pending, null)
  })

  test('a confirmed charter resolves with the edits the user made', async () => {
    const p = openGate(coerceCharter({ understood: 'u' }, 'r'))
    useCharter.getState().edit({ understood: 'what I actually meant' })
    useCharter.getState().confirm()
    assert.equal((await p)?.understood, 'what I actually meant')
    assert.equal(useCharter.getState().pending, null)
  })

  test('fields are edited one at a time, and the rest of the charter stays as it was', () => {
    void openGate(coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }], wontTouch: ['src/main'], doneWhen: 'npm test' }, 'r'))
    useCharter.getState().edit({ doneWhen: 'npm run typecheck' })
    const c = useCharter.getState().pending!
    assert.equal(c.doneWhen, 'npm run typecheck')
    assert.deepEqual([c.understood, c.wontTouch, c.assumptions.length, c.request], ['u', ['src/main'], 1, 'r'])
  })

  test('an edit that blanks a field is scored as blank, so the card cannot keep a confidence it no longer earns', () => {
    void openGate(coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }], wontTouch: ['src/renderer'], doneWhen: 'npm test' }, 'r'))
    assert.equal(useCharter.getState().pending?.confidence, 100)
    useCharter.getState().edit({ wontTouch: ['   '] })
    assert.deepEqual(useCharter.getState().pending?.wontTouch, [], 'a blank row is no exclusion')
    assert.equal(useCharter.getState().pending?.confidence, 90)
    useCharter.getState().edit({ doneWhen: '  ' })
    assert.equal(useCharter.getState().pending?.confidence, 60)
  })

  test('answering the question takes it, and the cap it put on confidence, off the charter', () => {
    void openGate(coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }], wontTouch: ['x'], doneWhen: 'npm test', question: { text: 'which split?', options: ['a', 'b'] }, ambiguity: 'subject' }, 'r'))
    assert.ok((useCharter.getState().pending?.confidence ?? 100) <= 70)
    useCharter.getState().edit({ question: undefined, ambiguity: undefined })
    assert.equal(useCharter.getState().pending?.question, undefined)
    assert.equal(useCharter.getState().pending?.ambiguity, undefined)
    assert.equal(useCharter.getState().pending?.confidence, 100)
  })

  test('an edit keeps the charter a follow-up', () => {
    void openGate({ ...coerceCharter({ understood: 'u' }, 'r'), followUpTo: 'lead-1' })
    useCharter.getState().edit({ understood: 'v' })
    assert.equal(useCharter.getState().pending?.followUpTo, 'lead-1')
  })

  test('a charter put up is always coercion output, whatever built it', () => {
    const bad = { ...coerceCharter({ understood: 'u' }, 'r'), confidence: 99, wontTouch: ['  '], assumptions: [{ text: 'a', known: true }] }
    void openGate(bad)
    const c = useCharter.getState().pending!
    assert.notEqual(c.confidence, 99, 'the score is worked out here, not believed')
    assert.deepEqual(c.wontTouch, [])
    assert.equal(c.assumptions[0]?.known, false, '"known" with nothing cited is a guess')
  })

  test('confirming, dismissing or editing with nothing up does nothing', () => {
    useCharter.getState().confirm()
    useCharter.getState().dismiss()
    useCharter.getState().edit({ understood: 'x' })
    assert.equal(useCharter.getState().pending, null)
  })

  test('a second charter waits behind the first: neither is lost, neither is answered for the user', async () => {
    const first = openGate(coerceCharter({ understood: 'first' }, 'r1'))
    const second = openGate(coerceCharter({ understood: 'second' }, 'r2'))
    assert.equal(useCharter.getState().pending?.understood, 'first')
    useCharter.getState().confirm()
    assert.equal((await first)?.understood, 'first')
    assert.equal(useCharter.getState().pending?.understood, 'second')
    useCharter.getState().dismiss()
    assert.equal(await second, null)
  })

  // ------------------------------------------------------------ the evidence check at the gate

  test('what a charter cites is looked up in the project, however the model wrote the path', async () => {
    withProject()
    const real = new Set(['/tmp/p/package.json', '/tmp/p/src/main/cli.ts', '/tmp/p/test', '/tmp/p/README.md'])
    ipc.handle('fs:exists', (p: string) => real.has(p))
    const c = coerceCharter(
      {
        understood: 'u',
        assumptions: [
          { text: 'a', known: true, from: './package.json' },
          { text: 'b', known: true, from: 'src\\main\\cli.ts' },
          { text: 'c', known: true, from: 'test/' },
          { text: 'd', known: true, from: '/tmp/p/README.md' },
          { text: 'e', known: true, from: '/etc/passwd' },
          { text: 'f', known: true, from: 'nope.ts' },
          { text: 'g', known: true, from: 'package.json' }
        ]
      },
      'r'
    )
    const p = gateCharter(c)
    const up = await cardUp()
    assert.deepEqual(
      up.assumptions.map((a) => a.known),
      [true, true, true, true, false, false, true],
      'a sloppy spelling of a real file is evidence; a missing file or one outside the project is not'
    )
    const asked = ipc.callsTo('fs:exists').map((a) => a[0])
    assert.ok(asked.every((q) => String(q).startsWith('/tmp/p/') || q === '/etc/passwd'), 'a relative path is asked about inside the project, never bare')
    assert.equal(new Set(asked).size, asked.length, 'a path cited twice is asked about once')
    useCharter.getState().dismiss()
    await p
  })

  test('with no project open nothing can be verified, and what claims to be known is a guess', async () => {
    const p = gateCharter(coerceCharter({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }] }, 'r'))
    const up = await cardUp()
    assert.equal(up.assumptions[0]?.known, false)
    assert.equal(ipc.callsTo('fs:exists').length, 0)
    useCharter.getState().dismiss()
    await p
  })

  test('the gate marks the charter a follow-up from where it is going, whatever it arrived marked', async () => {
    const p = gateCharter({ ...coerceCharter({ understood: 'u' }, 'r'), followUpTo: 'stale' }, lead as any)
    assert.equal((await cardUp()).followUpTo, 'lead-1')
    useCharter.getState().dismiss()
    await p
    const q = gateCharter({ ...coerceCharter({ understood: 'u' }, 'r'), followUpTo: 'stale' })
    assert.equal((await cardUp()).followUpTo, undefined)
    useCharter.getState().dismiss()
    await q
  })

  // ------------------------------------------------------------ door 1: sendGoal

  test('a goal with no team running costs one model call, and starts nothing until the charter is confirmed', async () => {
    withProject()
    drafts({ understood: 'Add a --json flag', doneWhen: 'npm test' })
    const sent = sendGoal('add a json flag')
    const card = await cardUp()
    await quiet()
    assert.equal(card.understood, 'Add a --json flag')
    assert.equal(card.followUpTo, undefined)
    assert.equal(ipc.callsTo('cli:run').length, 1, 'one headless run to draft it')
    assert.equal(started().length, 0, 'the Lead does not exist while the card is up')
    assert.equal(ipc.callsTo('fleet:isolation').length, 0, 'the folder question comes after the glance, not before')

    useCharter.getState().edit({ understood: 'Add a --json flag to the CLI' })
    useCharter.getState().confirm()
    const m = await sent
    assert.equal(m?.id, 'lead-new')
    assert.equal(started().length, 1)
    assert.equal(started()[0].goal, 'add a json flag', 'the typed goal still names the team')
    assert.equal(started()[0].charter.understood, 'Add a --json flag to the CLI', 'the Lead gets what the user confirmed')
    assert.equal(started()[0].charter.request, 'add a json flag')
  })

  test('a goal dismissed at the gate starts nothing and sends nothing', async () => {
    withProject()
    drafts({ understood: 'x' })
    const sent = sendGoal('add a json flag')
    await cardUp()
    useCharter.getState().dismiss()
    assert.equal(await sent, undefined)
    assert.equal(started().length, 0)
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0)
  })

  test('a goal sent while a Lead is live is a follow-up to it: a message, never a new team', async () => {
    withProject()
    withLead()
    drafts({ understood: 'Also cover the empty case' })
    const sent = sendGoal('also cover the empty case')
    const card = await cardUp()
    await quiet()
    assert.equal(card.followUpTo, 'lead-1', 'the card says whose follow-up it is')
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0, 'nothing reaches the Lead before the glance')

    useCharter.getState().edit({ understood: 'Also cover the empty list case' })
    useCharter.getState().confirm()
    const m = await sent
    assert.equal(m?.id, 'lead-1')
    assert.equal(started().length, 0, "startLead resets the running team's tasks and Ready card, so it is never reached")
    assert.equal(ipc.callsTo('fleet:isolation').length, 0)
    const [to, text] = ipc.callsTo('fleet:userMessage')[0] as [string, string]
    assert.equal(to, 'lead-1')
    assert.match(text, /Also cover the empty list case/, 'what was confirmed is what the Lead is told')
  })

  test('a follow-up dismissed at the gate reaches nobody', async () => {
    withProject()
    withLead()
    drafts({ understood: 'x' })
    const sent = sendGoal('also this')
    await cardUp()
    useCharter.getState().dismiss()
    assert.equal(await sent, undefined)
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0)
    assert.equal(started().length, 0)
  })

  test('a Lead that appeared while the card was up gets the goal as a message; a second team would discard its state', async () => {
    withProject()
    drafts({ understood: 'x' })
    const sent = sendGoal('do x')
    assert.equal((await cardUp()).followUpTo, undefined)
    withLead()
    useCharter.getState().confirm()
    await sent
    assert.equal(started().length, 0)
    assert.equal(ipc.callsTo('fleet:userMessage').length, 1)
  })

  test('a Lead that closed while the card was up is not written to: the goal starts a team, and is no longer a follow-up', async () => {
    withProject()
    withLead()
    drafts({ understood: 'x' })
    const sent = sendGoal('do x')
    assert.equal((await cardUp()).followUpTo, 'lead-1')
    useApp.setState({ live: {} })
    useCharter.getState().confirm()
    await sent
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0)
    assert.equal(started().length, 1)
    assert.equal(started()[0].charter.followUpTo, undefined)
  })

  test('a charter that came with the goal is gated as it is: no model call, and what it cites is still checked', async () => {
    withProject()
    ipc.handle('fs:exists', (p: string) => p === '/tmp/p/package.json')
    const given = coerceCharter(
      { understood: 'Oracle read it', assumptions: [{ text: 'scripts', known: true, from: 'package.json' }, { text: 'tests', known: true, from: 'ghost/' }], doneWhen: 'npm test' },
      'the typed words'
    )
    const sent = sendGoal("Oracle's rewrite of the goal", given)
    const card = await cardUp()
    assert.equal(ipc.callsTo('cli:run').length, 0, 'the common path stays at the one run Oracle already made')
    assert.deepEqual(card.assumptions.map((a) => a.known), [true, false])
    assert.ok(card.confidence < given.confidence)
    useCharter.getState().confirm()
    await sent
    assert.equal(started()[0].goal, "Oracle's rewrite of the goal")
    assert.equal(started()[0].charter.request, 'the typed words')
  })

  test('the folder question still comes before a team starts in a folder it cannot keep apart, and declining it starts nothing', async () => {
    withProject()
    ipc.handle('fleet:isolation', () => 'no-repo')
    const asked: string[] = []
    useApp.setState({ confirm: async (req: any) => (asked.push(req.title), false) } as any)
    const sent = sendGoal('x', coerceCharter({ understood: 'x' }, 'x'))
    await cardUp()
    assert.equal(asked.length, 0, 'the glance comes first')
    useCharter.getState().confirm()
    assert.equal(await sent, undefined)
    assert.equal(asked.length, 1)
    assert.equal(started().length, 0)
  })

  test('a project switched while the card was up is not sent to: its Lead was never the one the card named', async () => {
    withProject()
    drafts({ understood: 'x' })
    const sent = sendGoal('do x')
    await cardUp()
    useApp.setState({ project: { ...useApp.getState().project!, id: 'other' } })
    withLead()
    useCharter.getState().confirm()
    assert.equal(await sent, undefined)
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0)
    assert.equal(started().length, 0)
  })

  test('whatever charter a door hands over, startLead gets coercion output', async () => {
    withProject()
    const sent = sendGoal('x', { ...coerceCharter({ understood: 'u' }, 'r'), confidence: 99, wontTouch: ['  '], assumptions: [{ text: 'a', known: true }] })
    await cardUp()
    useCharter.getState().confirm()
    await sent
    const c = started()[0].charter
    assert.notEqual(c.confidence, 99)
    assert.deepEqual(c.wontTouch, [])
    assert.equal(c.assumptions[0].known, false)
  })

  // ------------------------------------------------------------ the Oracle path

  test("Oracle's team option with a charter is gated on that charter, with no second model call", async () => {
    withProject()
    useHelm.setState({
      card: {
        id: 'h',
        request: 'add a json flag',
        source: 'typed',
        reply: 'ok',
        ran: null,
        options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'Add a --json flag, with tests', charter: { understood: 'Add --json', doneWhen: 'npm test', wontTouch: ['src/renderer'] } }]
      }
    })
    const run = runHelmOption(0)
    const card = await cardUp()
    assert.equal(card.understood, 'Add --json')
    assert.equal(card.request, 'add a json flag', "the request is what the user typed, not Oracle's rewrite of it")
    assert.equal(ipc.callsTo('cli:run').length, 0)
    assert.equal(started().length, 0)
    useCharter.getState().confirm()
    await run
    assert.equal(started()[0].goal, 'Add a --json flag, with tests')
    assert.deepEqual(started()[0].charter.wontTouch, ['src/renderer'])
    assert.notEqual(started()[0].charter.request, started()[0].goal, "Oracle's rewrite differs from the typed request, so it follows the charter to the Lead")
  })

  test("Oracle's team option without a charter is gated on the request, in full, and still costs no second call", async () => {
    withProject()
    useHelm.setState({ card: { id: 'h', request: 'fix the split thing', source: 'typed', reply: 'ok', ran: null, options: [{ kind: 'team', label: 'Do it', detail: 'd', goal: 'Fix the split thing' }] } })
    const run = runHelmOption(0)
    const card = await cardUp()
    assert.equal(card.understood, 'fix the split thing')
    assert.ok(card.confidence < FULL_CARD_BELOW, 'a charter nobody wrote opens the full card')
    assert.equal(ipc.callsTo('cli:run').length, 0, 'not a model call: that would be the second one for this goal')
    useCharter.getState().dismiss()
    await run
    assert.equal(started().length, 0)
    assert.ok(!useThread.getState().entries.some((e) => /Started a Lead/.test(e.text)), 'a dismissed charter is not reported as a team started')
  })

  // ------------------------------------------------------------ door 2: runPlaybook

  test('a playbook drafts a charter from its brief and starts nothing until it is confirmed', async () => {
    withProject()
    drafts({ understood: 'Fix the duplicate ledger row', doneWhen: 'npm test' })
    const run = runPlaybook('hotfix', { bug: 'ledger sync creates a duplicate row' })
    const card = await cardUp()
    await quiet()
    assert.equal(ipc.callsTo('cli:run').length, 1)
    assert.match((ipc.callsTo('cli:run')[0]?.[0] as any).prompt, /"Hotfix: ledger sync creates a duplicate row"/, "the charter is drafted from what the user asked for, not from the playbook's step list")
    assert.equal(card.understood, 'Fix the duplicate ledger row')
    assert.equal(started().length, 0)
    useCharter.getState().confirm()
    const m = await run
    assert.equal(m?.id, 'lead-new')
    assert.equal(started().length, 1)
    assert.equal(started()[0].title, 'Hotfix: ledger sync creates a duplicate row', "the playbook's own title is kept")
    assert.match(started()[0].goal, /Playbook "Hotfix"/, 'and its brief')
    // goalMessageFor puts the goal after the charter only when it is not the request itself
    assert.equal(started()[0].charter.request, 'Hotfix: ledger sync creates a duplicate row', "the request is the user's words")
    assert.notEqual(started()[0].charter.request, started()[0].goal, "so the playbook's step list is not mistaken for it")
    assert.equal(started()[0].charter.understood, 'Fix the duplicate ledger row')
  })

  test('a playbook dismissed at the gate starts nothing', async () => {
    withProject()
    drafts({ understood: 'x' })
    const run = runPlaybook('hotfix', { bug: 'b' })
    await cardUp()
    useCharter.getState().dismiss()
    assert.equal(await run, null)
    assert.equal(started().length, 0)
  })

  // ------------------------------------------------------------ door 3: a send that submits

  describe('a message into a console', () => {
    const node = (id: string, name: string, i: number) => ({ id, type: 'console', x: i * 800, y: 0, w: 780, h: 440, z: i, data: { name, agentId: 'claude' } })
    const board = () => {
      useApp.setState({
        project: { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [node('lead-1', 'Rowan', 0), node('plain-1', 'Plain', 1)], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] } as any,
        live: { 'lead-1': true, 'plain-1': true }
      })
      useFleet.setState({ state: { members: { 'lead-1': lead } } as any })
    }
    const pasted = () => ipc.sent.filter((s) => s.channel === 'pty:paste').map((s) => s.args as [string, string, boolean])

    test('submitted to a team member it waits for the glance, then goes as confirmed', async () => {
      board()
      const run = runAction({ type: 'send', targets: ['Rowan'], text: 'also add tests', submit: true })
      const card = await cardUp()
      await quiet()
      assert.equal(card.understood, 'also add tests')
      assert.equal(card.followUpTo, 'lead-1')
      assert.equal(ipc.callsTo('cli:run').length, 0, 'a message into a console never costs a model call')
      assert.equal(pasted().length, 0, "nothing is typed into the Lead's terminal yet")

      useCharter.getState().edit({ understood: 'also add tests for the empty case' })
      useCharter.getState().confirm()
      const r = await run
      assert.equal(r.ok, true)
      assert.deepEqual(pasted(), [['lead-1', 'also add tests for the empty case.', true]])
    })

    test('dismissed, it is not sent, and the result says so', async () => {
      board()
      const run = runAction({ type: 'send', targets: ['Rowan'], text: 'also add tests', submit: true })
      await cardUp()
      useCharter.getState().dismiss()
      const r = await run
      assert.equal(r.ok, false)
      assert.match(r.line, /not sent/i)
      assert.equal(pasted().length, 0)
    })

    test('typed without submitting it goes straight in: text waiting for Enter is already a glance', async () => {
      board()
      const r = await promptly(runAction({ type: 'send', targets: ['Rowan'], text: 'also add tests', submit: false }))
      assert.equal(r.ok, true)
      assert.equal(useCharter.getState().pending, null)
      assert.deepEqual(pasted(), [['lead-1', 'also add tests', false]])
    })

    test('submitted to a console that is not part of a team, it goes as it always did', async () => {
      board()
      const r = await promptly(runAction({ type: 'send', targets: ['Plain'], text: 'run the tests', submit: true }))
      assert.equal(r.ok, true)
      assert.equal(useCharter.getState().pending, null)
      assert.deepEqual(pasted(), [['plain-1', 'run the tests', true]])
    })

    test('one message to a team member and a plain console: the plain one is not held up by the gate', async () => {
      board()
      const run = runAction({ type: 'send', targets: ['Rowan', 'Plain'], text: 'status?', submit: true })
      await cardUp()
      assert.deepEqual(pasted(), [['plain-1', 'status?', true]])
      useCharter.getState().confirm()
      await run
      assert.deepEqual(pasted().map((p) => p[0]).sort(), ['lead-1', 'plain-1'])
    })
  })
})
