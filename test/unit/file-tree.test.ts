// The studios' file tree, read in the main process: level by level, within a budget, deeper folders
// left unread for the tree to read when they are opened.
import '../support/electron-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TreeEntry } from '../../src/main/fsops'

const { tree } = await import('../../src/main/fsops')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-tree-'))
const put = (rel: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), '')
}
put('README.md')
put('b.ts')
put('src/main/java/com/acme/app/service/impl/deep/Deep.java')
put('docs/guide.md')
put('docs/img/logo.png')
put('node_modules/x/index.js')
fs.mkdirSync(path.join(root, 'empty'))
for (let i = 0; i < 50; i++) put(`many/f${i}.ts`)

const names = (list: TreeEntry[]) => list.map((e) => e.name)
const find = (list: TreeEntry[], rel: string) => rel.split('/').reduce<TreeEntry | undefined>((at, part) => (at ? at.children : list)?.find((e) => e.name === part), undefined)

test('folders first, by name; ignored folders left out', async () => {
  const t = await tree(root, 8)
  assert.deepEqual(names(t), ['docs', 'empty', 'many', 'src', 'b.ts', 'README.md'])
  assert.equal(find(t, 'node_modules'), undefined)
  assert.deepEqual(find(t, 'empty')?.children, [], 'a folder read and empty')
})

test('folders deeper than asked are left unread, not shown empty', async () => {
  const t = await tree(root, 2)
  assert.deepEqual(names(find(t, 'src/main')!.children!), ['java'])
  assert.equal(find(t, 'src/main/java')!.children, undefined, 'unread: the tree reads it when opened')
  // which it does, a level at a time
  const java = await tree(path.join(root, 'src/main/java'), 8)
  assert.ok(find(java, 'com/acme/app/service/impl/deep/Deep.java'))
})

test('past the budget, the rest is unread; nothing unread is shown as an empty folder', async () => {
  const t = await tree(root, 8, undefined, 20)
  const walk = (list: TreeEntry[]): void => {
    for (const e of list) {
      if (!e.dir || !e.children) continue
      if (e.children.length === 0) assert.equal(fs.readdirSync(e.path).length, 0, `${e.path} shown empty but is not`)
      walk(e.children)
    }
  }
  walk(t)
  assert.ok(JSON.stringify(t).length > 0)
  const unread = (list: TreeEntry[]): number => list.reduce((n, e) => n + (e.dir ? (e.children ? unread(e.children) : 1) : 0), 0)
  assert.ok(unread(t) > 0, 'some folders left for later')
})

test('with a filter (notes): only matching files, folders without any left out, unread ones kept', async () => {
  const md = (n: string) => n.endsWith('.md')
  const t = await tree(root, 8, md)
  // src only for its folder 9 levels down, which is not read: it may hold notes
  assert.deepEqual(names(t), ['docs', 'src', 'README.md'])
  assert.deepEqual(names(find(t, 'docs')!.children!), ['guide.md'])
  const shallow = await tree(root, 1, md)
  assert.ok(find(shallow, 'src/main'), 'an unread folder may hold notes: kept')
  assert.equal(find(shallow, 'src/main')!.children, undefined)
})

test('a folder that cannot be read is an empty list, not an error', async () => {
  assert.deepEqual(await tree(path.join(root, 'missing'), 8), [])
})
