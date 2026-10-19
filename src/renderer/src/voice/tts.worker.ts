// On-device text-to-speech: Kokoro (kokoro-js) off the UI thread.
// Messages in:  { type: 'load' } | { type: 'speak', id, text, voice }
// Messages out: { type: 'progress', pct } | { type: 'ready', device } | { type: 'audio', id, audio, rate }
//               | { type: 'error', id?, message }
import { KokoroTTS } from 'kokoro-js'

const ctx = self as any
const post = (msg: any, transfer?: Transferable[]) => ctx.postMessage(msg, transfer ?? [])
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let tts: KokoroTTS | null = null
let loading: Promise<KokoroTTS> | null = null
let device: 'webgpu' | 'wasm' = 'wasm'

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

function progress() {
  const files: Record<string, { loaded: number; total: number }> = {}
  let last = -1
  return (p: any) => {
    if (p.status !== 'progress' || !p.file) return
    files[p.file] = { loaded: p.loaded ?? 0, total: p.total ?? 0 }
    const all = Object.values(files)
    const total = all.reduce((s, f) => s + f.total, 0)
    if (!total) return
    const pct = Math.floor((all.reduce((s, f) => s + f.loaded, 0) / total) * 100)
    if (pct === last) return
    last = pct
    post({ type: 'progress', pct })
  }
}

async function load(forceWasm = false): Promise<KokoroTTS> {
  if (tts) return tts
  if (loading) return loading
  loading = (async () => {
    const progress_callback = progress()
    if (!forceWasm && (await hasWebGPU())) {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback })
        device = 'webgpu'
        post({ type: 'ready', device })
        return tts
      } catch {
        /* fall back to wasm */
      }
    }
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback })
    device = 'wasm'
    post({ type: 'ready', device })
    return tts
  })().finally(() => {
    loading = null
  })
  return loading
}

async function generate(text: string, voice: string) {
  const model = await load()
  const v = (voice in model.voices ? voice : 'af_heart') as any
  try {
    return await model.generate(text, { voice: v })
  } catch (e) {
    if (device !== 'webgpu') throw e
    // some GPUs load the model but fail at inference: retry on wasm
    tts = null
    const m = await load(true)
    return await m.generate(text, { voice: v })
  }
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data
  try {
    if (msg.type === 'load') await load()
    else if (msg.type === 'speak') {
      const raw: any = await generate(msg.text, msg.voice)
      const audio: Float32Array = raw.audio
      post({ type: 'audio', id: msg.id, audio, rate: raw.sampling_rate }, [audio.buffer])
    }
  } catch (e: any) {
    post({ type: 'error', id: msg.id, message: String(e?.message ?? e) })
  }
}
