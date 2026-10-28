// Spoken replies: Kokoro on-device (worker) with the system voice as a fallback while the model
// downloads or when it cannot run. Respects settings.speakReplies.
import { useApp } from '../state/store'
import { setVoice, useVoice } from './thread'

let worker: Worker | null = null
let ready = false
let failed = false
let loadStarted = false
let reqId = 0
let current = 0
let actx: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null
let meterFrame = 0
const waiting = new Map<number, (a: { audio: Float32Array; rate: number } | null) => void>()

function getWorker(): Worker | null {
  if (failed) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    failed = true
    return null
  }
  worker.onmessage = (ev) => {
    const m = ev.data
    if (m.type === 'progress') {
      const d = useVoice.getState().download
      if (!ready && (!d || d.what === 'voice')) setVoice({ download: { what: 'voice', pct: m.pct, label: 'Downloading voice' } })
    } else if (m.type === 'ready') {
      ready = true
      clearVoiceDownload()
    } else if (m.type === 'audio') {
      waiting.get(m.id)?.({ audio: m.audio, rate: m.rate })
      waiting.delete(m.id)
    } else if (m.type === 'error') {
      if (m.id != null) {
        waiting.get(m.id)?.(null)
        waiting.delete(m.id)
      }
      if (!ready) {
        failed = true
        clearVoiceDownload()
        console.warn('[voice] Kokoro unavailable, using system speech:', m.message)
      }
    }
  }
  worker.onerror = () => {
    failed = true
    ready = false
    clearVoiceDownload()
    waiting.forEach((r) => r(null))
    waiting.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

function clearVoiceDownload() {
  if (useVoice.getState().download?.what === 'voice') setVoice({ download: null })
}

/** Start loading the voice model in the background (first spoken reply uses the system voice). */
export function warmUpTts() {
  if (loadStarted || failed) return
  loadStarted = true
  getWorker()?.postMessage({ type: 'load' })
}

function systemSpeak(text: string, id: number) {
  const synth = window.speechSynthesis
  if (!synth) return end(id)
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.05
  u.onend = () => end(id)
  u.onerror = () => end(id)
  setVoice({ speaking: true })
  synth.speak(u)
  // some Linux setups never fire onend
  window.setTimeout(() => end(id), Math.min(15000, 1500 + text.length * 90))
}

function end(id: number) {
  if (id === current) {
    cancelAnimationFrame(meterFrame)
    setVoice({ speaking: false, outputLevel: null })
  }
}

/**
 * Turn text into audio with the on-device voice, without playing it. Null while the model isn't
 * loaded yet or when synthesis fails (callers fall back to the system voice).
 */
export async function synthesize(text: string): Promise<{ audio: Float32Array; rate: number } | null> {
  const w = getWorker()
  if (!w || !ready) return null
  const rid = ++reqId
  return new Promise((resolve) => {
    waiting.set(rid, resolve)
    w.postMessage({ type: 'speak', id: rid, text: text.slice(0, 600), voice: useApp.getState().settings.voiceName || 'af_heart' })
  })
}
export const ttsReady = () => ready

/** Speak a short reply. Resolves when playback starts (or immediately when speech is off). */
export async function speak(text: string) {
  const t = text.trim()
  if (!t) return
  if (!useApp.getState().settings.speakReplies) return
  stopSpeaking()
  const id = ++current
  warmUpTts()
  const w = getWorker()
  if (!w || !ready) return systemSpeak(t, id)
  setVoice({ speaking: true })
  const result = await synthesize(t)
  if (id !== current) return
  if (!result) return systemSpeak(t, id)
  try {
    if (!actx || actx.state === 'closed') actx = new AudioContext()
    if (actx.state === 'suspended') await actx.resume()
    const buf = actx.createBuffer(1, result.audio.length, result.rate)
    buf.copyToChannel(result.audio as Float32Array<ArrayBuffer>, 0)
    const src = actx.createBufferSource()
    src.buffer = buf
    src.connect(actx.destination)
    src.onended = () => {
      if (playing === src) playing = null
      end(id)
    }
    playing = src
    const started = actx.currentTime
    // Sample the PCM buffer at playback time, without introducing another audio connection.
    let sampled = 0
    const meter = (now: number) => {
      if (id !== current || playing !== src || !actx) return
      if (now - sampled >= 50) {
        sampled = now
        const offset = Math.floor((actx.currentTime - started) * result.rate)
        const count = Math.min(1024, result.audio.length - offset)
        let sum = 0
        for (let i = 0; i < count; i++) sum += result.audio[offset + i] ** 2
        setVoice({ outputLevel: count > 0 ? Math.min(1, Math.sqrt(sum / count) * 5) : 0 })
      }
      meterFrame = requestAnimationFrame(meter)
    }
    src.start()
    meterFrame = requestAnimationFrame(meter)
  } catch {
    systemSpeak(t, id)
  }
}

export function stopSpeaking() {
  current++
  cancelAnimationFrame(meterFrame)
  try {
    playing?.stop()
  } catch {
    /* already stopped */
  }
  playing = null
  window.speechSynthesis?.cancel()
  setVoice({ speaking: false, outputLevel: null })
}
