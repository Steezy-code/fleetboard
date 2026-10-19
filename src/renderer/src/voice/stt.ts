// Speech-to-text: mic capture (16 kHz mono Float32 PCM) + Whisper in a worker, plus the
// push-to-talk flow (begin → live caption → release → transcribe → route the command).
import { useApp } from '../state/store'
import { setVoice, useVoice } from './thread'
import { runCommand } from './planner'
import { stopSpeaking, warmUpTts } from './tts'

const RATE = 16000

// ---------------------------------------------------------------- whisper worker

let worker: Worker | null = null
let ready = false
let loadPromise: Promise<void> | null = null
let loadResolve: (() => void) | null = null
let loadReject: ((e: Error) => void) | null = null
let loadedModel = ''
let reqId = 0
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

const modelId = () => useApp.getState().settings.sttModel || 'onnx-community/whisper-base.en'

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev) => {
    const m = ev.data
    if (m.type === 'progress') {
      setVoice({ download: { what: 'speech', pct: m.pct, label: m.label } })
    } else if (m.type === 'ready') {
      ready = true
      setVoice({ download: null })
      loadResolve?.()
    } else if (m.type === 'result') {
      pending.get(m.id)?.resolve(m.text)
      pending.delete(m.id)
    } else if (m.type === 'error') {
      const err = new Error(m.message)
      if (m.id != null && pending.has(m.id)) {
        pending.get(m.id)!.reject(err)
        pending.delete(m.id)
      } else {
        loadReject?.(err)
      }
    }
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || 'Speech worker crashed')
    loadReject?.(err)
    pending.forEach((p) => p.reject(err))
    pending.clear()
    worker?.terminate()
    worker = null
    ready = false
    loadPromise = null
    setVoice({ download: null })
  }
  return worker
}

/** Load the speech model once (lazy; downloads from Hugging Face on first use, then cached). */
export function warmUpStt(): Promise<void> {
  const model = modelId()
  if (loadedModel && loadedModel !== model) {
    // model changed in settings: start a fresh worker
    worker?.terminate()
    worker = null
    ready = false
    loadPromise = null
  }
  if (loadPromise) return loadPromise
  loadedModel = model
  setVoice({ download: { what: 'speech', pct: null, label: 'Loading speech model' } })
  loadPromise = new Promise<void>((resolve, reject) => {
    loadResolve = resolve
    loadReject = (e) => {
      loadPromise = null
      setVoice({ download: null })
      reject(e)
    }
    getWorker().postMessage({ type: 'load', model })
  })
  return loadPromise
}

export const sttReady = () => ready

/** Transcribe 16 kHz mono PCM. Loads the model on first use. */
export async function transcribe(audio: Float32Array): Promise<string> {
  await warmUpStt()
  const id = ++reqId
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'transcribe', id, audio, model: modelId() })
  })
}

/** Whisper's filler for silence / noise. */
export function cleanTranscript(t: string): string {
  const s = t
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^(you|thank you\.?|thanks for watching!?|\.|bye\.?)$/i.test(s)) return ''
  return s
}

// ---------------------------------------------------------------- microphone

let stream: MediaStream | null = null
let actx: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let tap: AudioNode | null = null
let chunks: Float32Array[] = []
let recording = false
let idleTimer: number | undefined
let peak = 0
let lastLevelAt = 0

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('fb-tap', Tap)
`

function onPcm(buf: Float32Array) {
  if (!recording) return
  const data = actx && actx.sampleRate !== RATE ? resample(buf, actx.sampleRate, RATE) : buf
  chunks.push(data)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const rms = Math.sqrt(sum / (buf.length || 1))
  peak = Math.max(peak, Math.min(1, rms * 9))
  const now = performance.now()
  if (now - lastLevelAt < 50) return
  lastLevelAt = now
  const prev = useVoice.getState().level
  setVoice({ level: peak > prev ? peak : prev * 0.6 + peak * 0.4 })
  peak = 0
}

function resample(buf: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to
  const out = new Float32Array(Math.floor(buf.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(buf.length - 1, i0 + 1)
    out[i] = buf[i0] + (buf[i1] - buf[i0]) * (x - i0)
  }
  return out
}

async function openMic() {
  window.clearTimeout(idleTimer)
  if (stream && actx && tap) {
    if (actx.state === 'suspended') await actx.resume()
    return
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  try {
    actx = new AudioContext({ sampleRate: RATE })
  } catch {
    actx = new AudioContext()
  }
  source = actx.createMediaStreamSource(stream)
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await actx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const node = new AudioWorkletNode(actx, 'fb-tap')
    node.port.onmessage = (e) => onPcm(e.data as Float32Array)
    source.connect(node)
    tap = node
  } catch {
    // fallback for environments without AudioWorklet
    const sp = actx.createScriptProcessor(2048, 1, 1)
    sp.onaudioprocess = (e) => onPcm(new Float32Array(e.inputBuffer.getChannelData(0)))
    source.connect(sp)
    sp.connect(actx.destination)
    tap = sp
  }
}

/** Release the mic a while after the last use, so the next press starts instantly. */
function scheduleClose() {
  window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    if (recording) return
    try {
      source?.disconnect()
      tap?.disconnect()
    } catch {
      /* already gone */
    }
    stream?.getTracks().forEach((t) => t.stop())
    actx?.close()
    stream = null
    actx = null
    source = null
    tap = null
  }, 20000)
}

function joined(): Float32Array {
  const n = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Float32Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

function rmsOf(a: Float32Array) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / (a.length || 1))
}

// ---------------------------------------------------------------- push-to-talk flow

let startedAt = 0
let liveTimer: number | undefined
let liveBusy = false
let session = 0

export const isListening = () => recording

/** Start listening (key down / mic click). */
export async function beginListening() {
  if (recording) return
  if (!useApp.getState().project) return
  stopSpeaking()
  recording = true
  session++
  chunks = []
  startedAt = performance.now()
  setVoice({ phase: 'listening', transcript: '', reply: '', level: 0, captionUntil: 0 })
  warmUpStt()
    .then(() => {
      // the voice model downloads after the speech model, so the first reply can be spoken by Kokoro sooner
      if (useApp.getState().settings.speakReplies) warmUpTts()
    })
    .catch((e) => {
    useApp.getState().toast(`Speech model failed to load: ${e.message}. Typed commands still work.`, 'error')
  })
  try {
    await openMic()
  } catch (e: any) {
    recording = false
    setVoice({ phase: 'idle', level: 0 })
    useApp.getState().toast(`Microphone unavailable: ${e?.message ?? e}`, 'error')
    return
  }
  // live caption while the key is held
  window.clearInterval(liveTimer)
  const my = session
  liveTimer = window.setInterval(async () => {
    if (!recording || session !== my || liveBusy || !ready) return
    const audio = joined()
    if (audio.length < RATE * 0.8) return
    liveBusy = true
    try {
      const t = cleanTranscript(await transcribe(audio))
      if (recording && session === my && t) setVoice({ transcript: t })
    } catch {
      /* the final pass reports errors */
    } finally {
      liveBusy = false
    }
  }, 1400)
}

/** Stop listening (key up / mic click). With discard, throw the audio away. */
export async function endListening(discard = false) {
  if (!recording) return
  recording = false
  window.clearInterval(liveTimer)
  const held = performance.now() - startedAt
  const audio = joined()
  chunks = []
  scheduleClose()
  setVoice({ level: 0 })
  if (discard || held < 280 || audio.length < RATE * 0.3 || rmsOf(audio) < 0.004) {
    setVoice({ phase: 'idle', transcript: discard ? '' : useVoice.getState().transcript })
    return
  }
  const my = session
  setVoice({ phase: 'transcribing' })
  let text = ''
  try {
    text = cleanTranscript(await transcribe(audio))
  } catch (e: any) {
    if (session === my) setVoice({ phase: 'idle' })
    useApp.getState().toast(`Transcription failed: ${e?.message ?? e}`, 'error')
    return
  }
  if (session !== my) return
  if (!text) {
    setVoice({ phase: 'idle', transcript: '', reply: "Didn't catch that.", captionUntil: Date.now() + 2500 })
    return
  }
  setVoice({ phase: 'idle', transcript: text, captionUntil: Date.now() + 6000 })
  await runCommand(text, 'voice')
}

export function toggleListening() {
  if (recording) endListening()
  else beginListening()
}

/** Cancel the in-flight recording without transcribing (stop button / Esc). */
export function cancelListening() {
  if (recording) endListening(true)
  else if (useVoice.getState().phase === 'transcribing') {
    session++
    setVoice({ phase: 'idle' })
  }
}
