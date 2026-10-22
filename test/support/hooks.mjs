// Module loader hooks for the unit tests (see register.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformWithOxc } from 'vite'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ALIASES = [
  ['@shared/', path.join(root, 'src/shared/')],
  ['@/', path.join(root, 'src/renderer/src/')]
]
const EXTS = ['.ts', '.tsx', '.js', '.mjs']
const STUB = 'stub:'

function probe(base) {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const ext of EXTS) if (fs.existsSync(base + ext)) return base + ext
  for (const ext of EXTS) if (fs.existsSync(path.join(base, 'index' + ext))) return path.join(base, 'index' + ext)
  return null
}

export async function resolve(specifier, context, next) {
  // main-process code imports electron; tests get a recording stub instead
  if (specifier === 'electron') return { url: pathToFileURL(path.join(root, 'test/support/electron-stub.ts')).href, shortCircuit: true }
  // bundler-only imports: styles and Vite query imports become empty modules
  if (/\.(css|svg|png|woff2?)$/.test(specifier) || /\?(worker|url|raw|inline)$/.test(specifier)) {
    return { url: STUB + specifier, shortCircuit: true }
  }
  for (const [prefix, dir] of ALIASES) {
    if (specifier.startsWith(prefix)) {
      const hit = probe(path.join(dir, specifier.slice(prefix.length)))
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
    }
  }
  const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null
  if (parent && /^(\.{1,2})?\//.test(specifier) && !parent.includes('node_modules')) {
    const hit = probe(path.resolve(path.dirname(parent), specifier))
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith(STUB)) {
    const spec = url.slice(STUB.length)
    const body = spec.endsWith('?worker') ? 'export default class StubWorker {}' : `export default ${JSON.stringify(spec)}`
    return { format: 'module', source: body, shortCircuit: true }
  }
  if (/\.(ts|tsx)$/.test(url) && url.startsWith('file:') && !url.includes('/node_modules/')) {
    const file = fileURLToPath(url)
    const code = fs.readFileSync(file, 'utf8')
    const out = await transformWithOxc(code, file, {
      lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
      jsx: { runtime: 'automatic' },
      sourcemap: true
    })
    const map = out.map ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(out.map)).toString('base64')}` : ''
    return { format: 'module', source: out.code + map, shortCircuit: true }
  }
  return next(url, context)
}
