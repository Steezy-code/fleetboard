// The charter on the command bar: the Inbox item the card is drawn from, which of its two
// renderings a charter gets, and the two things the Inbox itself does to a team — a reply typed on a
// Ready card, and the Merge the charter's exclusions refuse.
import { ipc } from '../support/renderer-env'
import { test, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { coerceCharter, type Charter } from '@shared/charter'

const { useApp } = await import('@/state/store')
const { clearGate, openGate, useCharter } = await import('@/fleet/charter')
const { useFleet } = await import('@/engine/fleet')
const { charterHead, fullCard, refreshInbox, runAction, useInbox } = await import('@/fleet/inboxModel')

const project = { schema: 1, id: 'p', name: 'p', path: '/tmp/p', activeWorkspaceId: 'w', lastOpened: 0, extras: {}, workspaces: [{ id: 'w', name: 'W', nodes: [], groups: [], wires: [], ink: [], camera: { x: 0, y: 0, zoom: 1 }, extras: {} }] }

// createdAt now: a lead working since the epoch is a stalled one, and that is a notice of its own
const lead = { id: 'lead-1', name: 'Rowan', role: 'lead', status: 'working', agentId: 'claude', projectId: 'p', cwd: '/tmp/p', createdAt: Date.now() }

const fleet = (patch: Record<string, unknown>) =>
  useFleet.setState({ state: { projectId: 'p', projectPath: '/tmp/p', members: {}, tasks: [], messages: [], asks: [], ready: null, ...patch } as any })

/** build() is debounced onto a timer, so the list is read after it has run. */
const list = async () => {
  refreshInbox()
  await new Promise((r) => setTimeout(r, 10))
  return useInbox.getState().items
}
const charterItem = async () => {
  const i = (await list()).find((x) => x.kind === 'charter')
  assert.ok(i, 'a charter item is in the Inbox')
  return i
}
const labels = (i: { actions: { label: string }[] }) => i.actions.map((a) => a.label)
const primaries = (i: { actions: { label: string; primary?: boolean }[] }) => i.actions.filter((a) => a.primary).map((a) => a.label)

beforeEach(() => {
  ipc.reset()
  clearGate()
  useFleet.setState({ state: null })
  // the real confirm waits on a dialog nobody is here to answer, and Discard asks for one
  useApp.setState({ project: project as any, statuses: {}, live: {}, toast: () => {}, confirm: async () => false } as any)
  useInbox.setState({ items: [], front: null, open: false, folded: false, shownAt: 0 })
  ipc.handle('usage:spentIn', () => ({}))
  ipc.handle('fleet:userMessage', () => true)
  ipc.handle('fleet:mergeReady', () => ({ ok: true }))
})

// ---------------------------------------------------------------- the item

describe('the charter item', () => {
  test('a charter waiting is the first thing in the Inbox: nothing blocks the user harder than work that has not started', async () => {
    fleet({ members: { [lead.id]: lead }, asks: [{ id: 'a1', from: lead.id, question: 'which?', options: ['x'], at: 1 }] })
    void openGate(coerceCharter({ understood: 'Add a --json flag' }, 'add a json flag'))
    const items = await list()
    assert.deepEqual(items.map((i) => i.kind), ['charter', 'ask'])
  })

  test('with no team it is a new one; with a Lead running it names that Lead', async () => {
    void openGate(coerceCharter({ understood: 'u' }, 'add a json flag'))
    const fresh = await charterItem()
    assert.equal(fresh.who, 'New team')
    assert.match(fresh.sub, /add a json flag/)
    clearGate()
    fleet({ members: { [lead.id]: lead } })
    void openGate({ ...coerceCharter({ understood: 'u' }, 'also the empty case'), followUpTo: lead.id })
    assert.equal((await charterItem()).who, 'Rowan')
  })

  // A playbook always starts its own Lead, and startLead clears the running team's tasks and Ready
  // card. "New team starts with this" made that look like a fresh start beside the running one.
  test('a charter that will take a running team\'s place says so, and is still one question', async () => {
    fleet({ members: { [lead.id]: lead } })
    void openGate({ ...coerceCharter({ understood: 'u' }, 'r'), replaces: 'Rowan' })
    const item = await charterItem()
    assert.equal(item.who, 'New team')
    assert.equal(charterHead(item.charter), 'starts with this, replacing Rowan’s team')
    assert.deepEqual(labels(item), ['Confirm', 'Dismiss'], 'the warning is copy, not a second thing to answer')
    useCharter.getState().edit({ understood: 'v' })
    assert.equal(useCharter.getState().pending?.replaces, 'Rowan', 'and an edit does not lose it')
  })

  test('with nothing to replace, and for a follow-up, the card reads as it did', () => {
    assert.equal(charterHead(coerceCharter({ understood: 'u' }, 'r')), 'starts with this')
    assert.equal(charterHead({ ...coerceCharter({ understood: 'u' }, 'r'), followUpTo: lead.id }), 'gets this next')
  })

  test('a long request is clipped on the card', async () => {
    void openGate(coerceCharter({ understood: 'u' }, 'x'.repeat(300)))
    assert.ok((await charterItem()).sub.length < 120)
  })

  test('confirm is the primary answer and resolves the gate with what the card showed', async () => {
    const p = openGate(coerceCharter({ understood: 'Add a --json flag', doneWhen: 'npm test' }, 'add a json flag'))
    const item = await charterItem()
    assert.equal(labels(item)[0], 'Confirm')
    assert.equal(item.actions[0]?.primary, true)
    assert.equal(labels(item).at(-1), 'Dismiss')
    await runAction(item, 0)
    assert.equal((await p)?.understood, 'Add a --json flag')
    assert.equal(useCharter.getState().pending, null)
  })

  test('dismiss settles it with nothing, and the item leaves the Inbox', async () => {
    const p = openGate(coerceCharter({ understood: 'u' }, 'r'))
    const item = await charterItem()
    await runAction(item, item.actions.length - 1)
    assert.equal(await p, null)
    assert.deepEqual((await list()).map((i) => i.kind), [])
  })

  test('typing in the bar edits what was understood, and sends nothing anywhere', async () => {
    const p = openGate(coerceCharter({ understood: 'Add a flag', doneWhen: 'npm test' }, 'add a json flag'))
    const item = await charterItem()
    assert.ok(item.replyTo, 'the bar goes to the card')
    await item.replyTo!.send('Add a --json flag to the CLI')
    assert.equal(useCharter.getState().pending?.understood, 'Add a --json flag to the CLI')
    assert.equal(useCharter.getState().pending?.doneWhen, 'npm test', 'and leaves the rest of the charter alone')
    assert.equal(ipc.calls.length, 0, 'nothing is sent while the charter is still being agreed')
    await runAction(await charterItem(), 0)
    assert.equal((await p)?.understood, 'Add a --json flag to the CLI')
  })

  test('the one question becomes a button each; picking one answers it and starts nothing', async () => {
    const asked = coerceCharter(
      {
        understood: 'Fix the split thing',
        assumptions: [{ text: 'commands live in cli.ts', known: true, from: 'src/main/cli.ts' }],
        wontTouch: ['src/renderer'],
        doneWhen: 'npm test',
        question: { text: 'Which split?', options: ['the PDF command', 'the CSV splitter'] },
        ambiguity: 'subject'
      },
      'fix the split thing'
    )
    const p = openGate(asked)
    const item = await charterItem()
    assert.equal(asked.confidence, 70, 'the question caps what the charter can claim')
    assert.deepEqual(labels(item), ['Confirm', 'the PDF command', 'the CSV splitter', 'Dismiss'])
    await runAction(item, 1)
    const after = useCharter.getState().pending!
    assert.ok(after, 'answering the question does not start the work')
    assert.equal(after.question, undefined, 'the question is answered, so it is not asked again')
    assert.equal(after.ambiguity, undefined)
    assert.match(after.understood, /the PDF command/, 'and what the user chose is in what the Lead will be told')
    assert.equal(after.confidence, 100, 'the cap the question put on confidence is gone with it')
    assert.deepEqual(labels(await charterItem()), ['Confirm', 'Dismiss'])
    await runAction(await charterItem(), 0)
    assert.match((await p)!.understood, /the PDF command/)
  })

  test('a charter takes the front from whatever was there, unfolded: the gate is the one card that cannot be missed', async () => {
    fleet({ members: { [lead.id]: lead }, asks: [{ id: 'a1', from: lead.id, question: 'which?', options: ['x'], at: 1 }] })
    await list()
    useInbox.setState({ folded: true })
    assert.equal(useInbox.getState().front, 'ask:a1')
    void openGate(coerceCharter({ understood: 'u' }, 'r'))
    const items = await list()
    assert.equal(useInbox.getState().front, items[0]?.key)
    assert.equal(items[0]?.kind, 'charter')
    assert.equal(useInbox.getState().folded, false)
  })
})

// ---------------------------------------------------------------- which rendering

describe('the two renderings', () => {
  const at = (c: Partial<Charter>) => coerceCharter(c, 'r')

  test('an unsure charter with work to show opens the full card', () => {
    const c = at({ understood: 'u', assumptions: [{ text: 'tests live in test/', known: false }], doneWhen: 'npm test' })
    assert.ok(c.confidence < 80)
    assert.equal(fullCard(c), true)
  })

  test('a confident charter that rules nothing out is a one-line glance', () => {
    const c = at({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }], doneWhen: 'npm test' })
    assert.equal(c.confidence, 90)
    assert.equal(fullCard(c), false)
  })

  // The one-line form shows `understood` and `doneWhen` and has nowhere to put an exclusion. A
  // charter that scores 100 on all-known assumptions would have gone through as one line with
  // "src/renderer" on it, unseen — and then refused the user's own merge for touching it.
  test('an exclusion opens the full card however confident the charter is: it is what a merge is refused for', () => {
    const c = at({ understood: 'u', assumptions: [{ text: 'a', known: true, from: 'package.json' }], wontTouch: ['src/renderer'], doneWhen: 'npm test' })
    assert.equal(c.confidence, 100)
    assert.equal(fullCard(c), true)
  })

  test('a one-line message has nothing to put in a full card, whatever it scores', () => {
    const c = coerceCharter(null, "tell Kaz it's Windows-only")
    assert.ok(c.confidence < 80, 'a charter nobody wrote scores low')
    assert.equal(fullCard(c), false, 'and a card of empty headings is worse than the line itself')
  })

  test('a question, or an exclusion the one-line form cannot show, is enough to open it', () => {
    assert.equal(fullCard(at({ understood: 'u', question: { text: 'which?', options: [] } })), true)
    assert.equal(fullCard(at({ understood: 'u', wontTouch: ['src/main'] })), true)
  })
})

// ---------------------------------------------------------------- the Inbox's own doors

describe('the Ready card', () => {
  const ready = { leadId: lead.id, branch: 'fleet/x', summary: 'did it', commits: 2, files: ['src/a.ts'], hasRemote: true, at: 5 }
  const readyItem = async () => {
    const i = (await list()).find((x) => x.kind === 'ready')
    assert.ok(i, 'a Ready card is in the Inbox')
    return i
  }

  test('a reply typed on it is work for the team, so it crosses the gate before the Lead hears it', async () => {
    fleet({ members: { [lead.id]: lead }, ready })
    const item = await readyItem()
    assert.ok(item.replyTo)
    const sent = item.replyTo!.send('also cover the empty case')
    for (let i = 0; i < 100 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
    assert.ok(useCharter.getState().pending, 'the charter is up')
    assert.equal(useCharter.getState().pending?.followUpTo, lead.id)
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0, 'and nothing has reached the Lead')
    useCharter.getState().edit({ understood: 'also cover the empty list case' })
    useCharter.getState().confirm()
    await sent
    const [to, text] = (ipc.callsTo('fleet:userMessage')[0] ?? []) as [string, string]
    assert.equal(to, lead.id)
    assert.equal(text, 'also cover the empty list case.')
  })

  test('dismissed at the gate, the reply reaches nobody', async () => {
    fleet({ members: { [lead.id]: lead }, ready })
    const item = await readyItem()
    const sent = item.replyTo!.send('also this')
    for (let i = 0; i < 100 && !useCharter.getState().pending; i++) await new Promise((r) => setTimeout(r, 2))
    useCharter.getState().dismiss()
    await sent
    assert.equal(ipc.callsTo('fleet:userMessage').length, 0)
  })

  test('work that touched a file the charter ruled out cannot be merged from the card', async () => {
    fleet({ members: { [lead.id]: { ...lead, owns: ['src'] } }, ready, charter: coerceCharter({ understood: 'u', wontTouch: ['src/a.ts'] }, 'r') })
    const item = await readyItem()
    assert.equal(item.kind === 'ready' && item.review?.blocked, true)
    assert.ok(!labels(item).includes('Merge'), 'Merge is not on offer')
    assert.deepEqual(primaries(item), ['View diff'], 'reading it is what is left to do')
    assert.ok(labels(item).includes('Open draft PR'), 'pushing is not merging, and a draft PR is how someone else gets to see the file')
    for (let i = 0; i < item.actions.length; i++) await item.actions[i]!.run()
    assert.equal(ipc.callsTo('fleet:mergeReady').length, 0, 'and nothing on the card merges it')
  })

  test('a blocked card with nothing to merge still has exactly one primary answer', async () => {
    // the PR is open, so the card closes the team rather than merging it: Done stays the primary and
    // View diff must not become a second one
    fleet({ members: { [lead.id]: { ...lead, owns: ['src'] } }, ready: { ...ready, prUrl: 'https://example.test/pr/1' }, charter: coerceCharter({ understood: 'u', wontTouch: ['src/a.ts'] }, 'r') })
    const item = await readyItem()
    assert.equal(item.kind === 'ready' && item.review?.blocked, true)
    assert.deepEqual(primaries(item), ['Done'])
  })

  // Opening another project swaps the board without a reload, and main keeps a team state per
  // project: an undo offered there would revert in the wrong checkout, or be refused for a reason
  // that is not true of it.
  test('the undo offered after a merge belongs to the project the merge was made in', async () => {
    ipc.handle('fleet:mergeReady', () => ({ ok: true, commit: 'abc1234', into: 'main' }))
    fleet({ members: { [lead.id]: lead }, ready })
    const item = await readyItem()
    await runAction(item, labels(item).indexOf('Merge'))
    fleet({ members: {}, ready: null })
    const merged = async () => (await list()).find((i) => i.key === 'merged:abc1234')
    assert.ok(await merged(), 'the project it was made in offers the undo')
    useApp.setState({ project: { ...project, id: 'q' } as any })
    assert.equal(await merged(), undefined, 'another project’s Inbox does not')
    useApp.setState({ project: project as any })
    const back = await merged()
    assert.ok(back, 'and coming back within the window offers it again')
    await runAction(back, labels(back).indexOf('Looks right'))
    assert.equal(await merged(), undefined)
  })

  test('work inside what the charter allowed still merges with one click', async () => {
    fleet({ members: { [lead.id]: { ...lead, owns: ['src'] } }, ready, charter: coerceCharter({ understood: 'u', wontTouch: ['docs'] }, 'r') })
    const item = await readyItem()
    assert.equal(item.kind === 'ready' && item.review?.blocked, false)
    assert.equal(labels(item)[0], 'Merge')
    assert.equal(item.actions[0]?.primary, true)
  })
})

// ---------------------------------------------------------------- nothing is left waiting

test('a project closed lets every door still waiting at the gate go', async () => {
  const first = openGate(coerceCharter({ understood: 'a' }, 'a'))
  const second = openGate(coerceCharter({ understood: 'b' }, 'b'))
  clearGate()
  assert.deepEqual([await first, await second], [null, null], 'a promise nobody can answer any more is let go, not left hanging')
  assert.equal(useCharter.getState().pending, null)
  assert.deepEqual((await list()).map((i) => i.kind), [])
})
