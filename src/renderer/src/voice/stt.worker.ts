// On-device speech-to-text: Whisper through @huggingface/transformers, off the UI thread.
// Messages in:  { type: 'load', model } | { type: 'transcribe', id, audio: Float32Array }
// Messages out: { type: 'progress', pct, label } | { type: 'ready', device } | { type: 'result', id, text }
//               | { type: 'error', id?, message }
import { env, pipeline } from '@huggingface/transformers'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'

const ctx = self as any
const post = (msg: any) => ctx.postMessage(msg)

// Serve the ONNX runtime from the app bundle instead of a CDN (works offline once the model is cached).
try {
  const wasm = (env.backends.onnx as any).wasm
  if (wasm) wasm.wasmPaths = { mjs: new URL(ortMjs, self.location.href).href, wasm: new URL(ortWasm, self.location.href).href }
} catch {
  /* keep the library default */
}
env.allowLocalModels = false

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

let transcriber: Transcriber | null = null
let loading: Promise<void> | null = null
let loadedModel = ''
let isEnglishOnly = false

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu
    if (!gpu) return false
    return !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function cacheUsable(): Promise<boolean> {
  try {
    await caches.open('fleetboard-probe')
    return true
  } catch {
    return false
  }
}

function progressReporter() {
  const files: Record<string, { loaded: number; total: number }> = {}
  let last = -1
  return (p: any) => {
    let pct: number | null = null
    if (p.status === 'progress_total') pct = p.progress
    else if (p.status === 'progress' && p.file) {
      files[p.file] = { loaded: p.loaded ?? 0, total: p.total ?? 0 }
      const all = Object.values(files)
      const total = all.reduce((s, f) => s + f.total, 0)
      pct = total ? (all.reduce((s, f) => s + f.loaded, 0) / total) * 100 : null
    } else return
    if (pct == null) return
    const r = Math.floor(pct)
    if (r === last) return
    last = r
    post({ type: 'progress', pct: r, label: 'Downloading speech model' })
  }
}

async function load(model: string) {
  if (transcriber && loadedModel === model) return
  if (loading) return loading
  loading = (async () => {
    env.useBrowserCache = await cacheUsable()
    isEnglishOnly = /\.en$/i.test(model)
    const progress_callback = progressReporter()
    const tries: { device: 'webgpu' | 'wasm'; dtype: any }[] = []
    if (await hasWebGPU()) tries.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } })
    tries.push({ device: 'wasm', dtype: 'q8' })
    let lastErr: unknown
    for (const t of tries) {
      try {
        const p = await (pipeline as any)('automatic-speech-recognition', model, {
          device: t.device,
          dtype: t.dtype,
          progress_callback
        })
        transcriber = p as Transcriber
        loadedModel = model
        // compile shaders / warm caches with a short silent clip
        try {
          await transcriber(new Float32Array(16000), isEnglishOnly ? {} : { task: 'transcribe' })
        } catch {
          /* warm-up is best effort */
        }
        post({ type: 'ready', device: t.device })
        return
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error('Could not load the speech model')
  })().finally(() => {
    loading = null
  })
  return loading
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data
  try {
    if (msg.type === 'load') {
      await load(msg.model)
    } else if (msg.type === 'transcribe') {
      await load(msg.model)
      const out = await transcriber!(msg.audio as Float32Array, {
        ...(isEnglishOnly ? {} : { task: 'transcribe' }),
        chunk_length_s: 30,
        stride_length_s: 5
      })
      const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
      post({ type: 'result', id: msg.id, text: text ?? '' })
    }
  } catch (e: any) {
    post({ type: 'error', id: msg.id, message: String(e?.message ?? e) })
  }
}
