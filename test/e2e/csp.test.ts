// script-src named blob: for one reason: the push-to-talk microphone tap was a template literal
// turned into a blob: URL. That single line made "a string got into the page" and "that string ran"
// the same event, which is the whole of an injection. The tap is a file now, so the grant is gone.
//
// Both halves are checked against the real page, because the dangerous failure here is silent: the
// worklet load has a ScriptProcessorNode fallback, so a CSP that refused it would leave push-to-talk
// working on the deprecated path with nobody the wiser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { App, makeRepo, makeSandbox } from './harness'

test('the microphone tap loads as a file, and a script built from a string does not', async () => {
  const assets = path.join(process.cwd(), 'out', 'renderer', 'assets')
  const worklet = fs.readdirSync(assets).find((f) => /^tap\.worklet-.*\.js$/.test(f))
  assert.ok(worklet, 'the worklet is emitted as its own file, not inlined as a data: URL')

  const sb = makeSandbox()
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(makeRepo(sb))
    const r = await app.eval(async (name) => {
      const ctx = new AudioContext()
      const out: Record<string, string> = {}
      try {
        await ctx.audioWorklet.addModule(`assets/${name}`)
        const node = new AudioWorkletNode(ctx, 'fb-tap')
        out.file = node.numberOfOutputs >= 0 ? 'loaded' : 'no node'
      } catch (e: any) {
        out.file = `refused: ${e?.message ?? e}`
      }
      try {
        const url = URL.createObjectURL(new Blob(['registerProcessor("x", class extends AudioWorkletProcessor { process() { return true } })'], { type: 'application/javascript' }))
        await ctx.audioWorklet.addModule(url)
        out.blob = 'loaded'
      } catch (e: any) {
        out.blob = `refused: ${e?.message ?? e}`
      }
      await ctx.close()
      return out
    }, worklet)

    assert.equal(r.file, 'loaded', 'the real tap still loads, so push-to-talk is not quietly on the fallback')
    assert.match(r.blob, /^refused:/, 'and a worklet built from a string in the page is refused')
    // 'wasm-unsafe-eval' stays: it lets WebAssembly compile (the speech model's runtime needs it) and
    // cannot turn a string into JavaScript, which is the thing being refused here.
    const scriptSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8').match(/script-src[^;]*/)?.[0] ?? ''
    assert.doesNotMatch(scriptSrc, /blob:|data:|'unsafe-inline'|(?<!wasm-)'unsafe-eval'/, 'script-src names nothing that turns a string into code')
    assert.match(scriptSrc, /'wasm-unsafe-eval'/, 'and still lets WebAssembly compile')
  } finally {
    await app.close()
  }
})
