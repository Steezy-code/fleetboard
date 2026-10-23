// Repo files a user opens in the vault are untrusted text, read on every render: the heading and
// link readers must answer the same as before on ordinary notes, and stay linear on crafted ones.
import { ipc } from '../support/renderer-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { firstHeading, extractLinks } = await import('@/workbench/markdown')
void ipc

test('first heading: ordinary notes read as before; a closing #-run needs a space before it', () => {
  assert.equal(firstHeading('# Title'), 'Title')
  assert.equal(firstHeading('intro\n# Next steps ##\nbody'), 'Next steps')
  assert.equal(firstHeading('## A second-level heading'), null, 'the note\'s title is its first level-1 heading')
  assert.equal(firstHeading('   # Indented'), 'Indented')
  assert.equal(firstHeading('# **Bold** title'), 'Bold title')
  assert.equal(firstHeading('```\n# not this\n```\n# This'), 'This')
  assert.equal(firstHeading('# C#'), 'C#', 'the language, not a closing run')
  assert.equal(firstHeading('no heading here'), null)
})

test('links: wiki and file links found as before', () => {
  const r = extractLinks('See [[Plan|the plan]] and [notes](docs/notes.md#top) and [x](https://e.invalid/a.md).')
  assert.deepEqual(r.wiki, ['Plan'])
  assert.deepEqual(r.files, ['docs/notes.md'])
})

test('a padded heading line and a page of "](" stay fast', () => {
  const t = Date.now()
  firstHeading('#' + ' '.repeat(100_000) + 'x' + ' '.repeat(100_000))
  extractLinks('](a'.repeat(64_000))
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`)
})
