// Opt-in workload benchmark. Emits comparable JSON and applies generous regression limits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { App, makeRepo, makeSandbox } from './harness'

for (const count of [20, 50]) test(`${count} terminals: output, camera frames, input latency and memory`, { skip: process.env.FB_BENCH !== '1' || process.platform === 'win32', timeout: 120_000 }, async () => {
  const sb = makeSandbox()
  const repo = makeRepo(sb, 'benchmark', { 'README.md': '# Benchmark' })
  const app = await App.launch({ sandbox: sb })
  try {
    await app.openProject(repo)
    const ids: string[] = await app.eval((count) => (window as any).__fleetboard.spawnConsoles({ agentId: 'shell', count }), count)
    await app.waitFor(async () => (await app.invoke('pty:list')).filter((p: any) => p.status === 'idle').length === count, { timeout: 30_000, label: 'all terminals running' })
    // Keep the first shell free for a latency probe while the other terminals print.
    await app.eval((ids) => { for (const id of ids.slice(1)) (window as any).__fleetboard.sendToConsole(id, "for ((i=0; i<160; i++)); do printf 'benchmark output %s\\n' \"$i\"; read -r -t 0.1 unused; done", true) }, ids)
    const frames = await app.eval(async () => {
      const app = (window as any).__fleetboard.useApp.getState()
      const samples: number[] = []
      let last = performance.now()
      const start = last
      const warmupMs = 2000
      while (performance.now() - start < 10_000) {
        await new Promise(requestAnimationFrame)
        const now = performance.now(); if (now - start >= warmupMs) samples.push(now - last); last = now
        app.setCamera({ x: Math.sin(now / 400) * 300, y: Math.cos(now / 400) * 100, zoom: 0.4 + Math.sin(now / 900) * 0.1 })
      }
      samples.sort((a, b) => a - b)
      return { warmupMs, p95: samples[Math.floor(samples.length * 0.95)], max: samples.at(-1), count: samples.length }
    })
    const start = performance.now()
    await app.eval((id) => (window as any).__fleetboard.sendToConsole(id, "printf '\\106\\102\\137\\120\\111\\116\\107\\n'", true), ids[0])
    await app.waitFor(async () => /FB_PING/.test(await app.invoke('pty:tail', ids[0], 2000)), { timeout: 5000, label: 'echo response under load' })
    const inputMs = performance.now() - start
    const heap = await (app as any).cdp.send('Runtime.getHeapUsage')
    const result = { count, frames, inputMs, heapBytes: heap.usedSize, platform: process.platform, cpu: os.cpus()[0]?.model, at: new Date().toISOString() }
    if (process.env.FB_BENCH_OUT) fs.appendFileSync(process.env.FB_BENCH_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify(result))
    assert.ok(frames.p95 < 250, `p95 frame interval ${frames.p95}ms exceeds 250ms`)
    assert.ok(inputMs < 3000, `terminal echo latency ${inputMs}ms exceeds 3s`)
    assert.ok(heap.usedSize < 1024 ** 3, 'renderer JS heap exceeded 1 GiB')
    assert.deepEqual(app.rendererErrors, [])
  } finally { await app.close() }
})
