// The title and file name of a generated document come from its first heading, which an agent wrote.
// titleOf's optional chain stopped one link short of the capture group it reads, so the shape of the
// expression claimed a guard it did not have; these pin what it answers either way.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { titleOf, slugify } = await import('@/studios/docs/presets')

test('the first heading is the title, with its markdown markers taken off', () => {
  assert.equal(titleOf('# Hello world\n\nbody'), 'Hello world')
  assert.equal(titleOf('# **Bold** and `code`\n'), 'Bold and code')
  assert.equal(titleOf('intro\n\n#\tTabbed heading\n'), 'Tabbed heading')
})

test('a document with no heading has no title, rather than an empty one', () => {
  assert.equal(titleOf('no heading here'), undefined)
  assert.equal(titleOf(''), undefined)
  // "#" with nothing after it is not a heading with an empty title
  assert.equal(titleOf('#\n'), undefined)
  assert.equal(titleOf('## second level\n'), undefined)
})

test('a file name falls back to something rather than nothing', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('—'), 'document')
  assert.equal(slugify(''), 'document')
})
