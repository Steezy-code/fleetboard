// The porcelain v2 parser, on records it should not be given. A status read covers the whole repo,
// so one record the parser cannot read must cost that one file and not the panel: reading the XY
// field's first character without checking the field was there threw, and the throw came out of the
// main process in place of every file's status.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseStatus } = await import('../../src/main/git')

const rec = (...fields: string[]) => fields.join(' ')
const ordinary = rec('1', 'M.', 'N...', '100644', '100644', '100644', 'aaa', 'bbb', 'src/a.ts')

test('a record with no XY field at all is skipped, and the rest still parses', () => {
  const st = parseStatus(['1', ordinary].join('\0'), '/repo')
  assert.deepEqual(
    st.files.map((f) => f.path),
    ['src/a.ts']
  )
})

test('a one-character XY field is skipped rather than read past its end', () => {
  for (const bad of ['1 M', '2 R', 'u U']) {
    const st = parseStatus([bad, ordinary].join('\0'), '/repo')
    assert.deepEqual(
      st.files.map((f) => f.path),
      ['src/a.ts'],
      bad
    )
  }
})

test('the fields of an ordinary record are unchanged by the guard', () => {
  const [f] = parseStatus(ordinary, '/repo').files
  assert.deepEqual(f, { path: 'src/a.ts', code: 'M', x: 'M', y: '.', staged: true, unstaged: false, untracked: false })
})

test('the branch header and an untracked file still read as before', () => {
  const st = parseStatus(['# branch.oid abcdef1234', '# branch.head main', '# branch.ab +2 -1', '? new.ts', ordinary].join('\0'), '/repo')
  assert.equal(st.branch, 'main')
  assert.equal(st.detached, false)
  assert.equal(st.ahead, 2)
  assert.equal(st.behind, 1)
  assert.deepEqual(
    st.files.map((f) => [f.path, f.code]),
    [
      ['new.ts', '?'],
      ['src/a.ts', 'M']
    ]
  )
})
