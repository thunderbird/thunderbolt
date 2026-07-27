/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * VAD gate (THU-684) — mic capture + energy-based endpointing, zero in-browser ML.
 *
 * The capture worklet resamples the mic to 16 kHz frames; we detect speech by
 * frame RMS energy and end the turn after a trailing-silence window, emitting the
 * committed utterance for the STT engine. This is deliberately simple (no models
 * on the client) — a lightweight gate so we only send *speech* to the STT
 * provider, not a continuous mic stream. A streaming STT with server-side
 * endpointing (e.g. Tinfoil voxtral-realtime) can supersede it later; energy VAD
 * is the crude-but-dependency-free MVP.
 *
 * `getUserMedia` runs with echo cancellation on; `onSpeechStart` is the barge-in
 * trigger (unused while half-duplex, but kept for when full-duplex returns).
 */
import { concatFrames } from '@/voice/engine/audio-engine'
import { MediaDevicesUnavailableError } from '@/voice/voice-error'

export type VadHandlers = {
  onSpeechStart?: () => void
  /** A committed utterance (mono Float32Array @ 16 kHz) ready for transcription. */
  onUtterance: (audio: Float32Array) => void
  /** Speech started but was too short to be a real utterance. */
  onMisfire?: () => void
  /** Per-frame mic RMS [0,1] while listening — drives the live waveform. */
  onLevel?: (rms: number) => void
}

export type VadGate = {
  start: () => Promise<void>
  pause: () => Promise<void>
  destroy: () => Promise<void>
  /** Gate frame processing. Paused = no self-triggering while the assistant
   *  speaks (half-duplex). */
  setListening: (value: boolean) => void
}

/** Frames are 512 samples (~32 ms) — set by the capture worklet. */
const speechRmsThreshold = 0.015 // normalized [-1,1] amplitude; tune for the mic
const minSpeechFrames = 8 // ~256 ms — shorter is a misfire
// ~1.4 s of trailing silence ends the turn. Long enough to think mid-sentence
// without it firing on a natural pause; a streaming STT with semantic
// endpointing would let us shorten this later.
const endSilenceFrames = 45
const prerollFrames = 4 // keep a little audio before onset so we don't clip it

const aecConstraints: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}

const rms = (frame: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i]
  }
  return Math.sqrt(sum / frame.length)
}

export const createVadGate = (handlers: VadHandlers): VadGate => {
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null

  let listening = true
  let speaking = false
  let collected: Float32Array[] = []
  let preroll: Float32Array[] = []
  let silenceRun = 0
  let speechFrames = 0 // frames actually above threshold (excludes trailing silence)

  const reset = () => {
    speaking = false
    collected = []
    silenceRun = 0
    speechFrames = 0
  }

  const endUtterance = () => {
    const frames = collected
    const speech = speechFrames
    reset()
    // Gate on real speech only — `collected` also holds preroll + the ~1.4 s of
    // trailing silence, so counting frames.length would never detect a misfire.
    if (speech < minSpeechFrames) {
      handlers.onMisfire?.()
      return
    }
    handlers.onUtterance(concatFrames(frames))
  }

  const processFrame = (frame: Float32Array) => {
    const level = rms(frame)
    handlers.onLevel?.(level)
    if (level >= speechRmsThreshold) {
      if (!speaking) {
        speaking = true
        collected = [...preroll]
        handlers.onSpeechStart?.()
      }
      collected.push(frame)
      silenceRun = 0
      speechFrames++
    } else if (speaking) {
      collected.push(frame)
      silenceRun++
      if (silenceRun >= endSilenceFrames) {
        endUtterance()
      }
    } else {
      preroll.push(frame)
      if (preroll.length > prerollFrames) {
        preroll.shift()
      }
    }
  }

  const start = async () => {
    // WKWebView hides `navigator.mediaDevices` outside a secure context (a Tauri
    // dev build over http://localhost), so guard before dereferencing it — a raw
    // "undefined is not an object" TypeError isn't actionable.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MediaDevicesUnavailableError()
    }
    stream = await navigator.mediaDevices.getUserMedia(aecConstraints)
    // Native mic rate (can't connect a MediaStreamSource across rates); the
    // worklet resamples to 16 kHz.
    ctx = new AudioContext()
    // Mobile webviews create the context suspended even inside a gesture; resume
    // so the capture graph actually pulls frames.
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
    await ctx.audioWorklet.addModule('/voice/capture-worklet.js')
    node = new AudioWorkletNode(ctx, 'capture-processor')
    ctx.createMediaStreamSource(stream).connect(node)
    node.connect(ctx.destination) // worklet has no output; keeps the graph pulling
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (listening) {
        processFrame(event.data)
      }
    }
  }

  const pause = async () => {
    if (node) {
      node.port.onmessage = null
    }
    node?.disconnect()
    await ctx?.suspend()
  }

  const destroy = async () => {
    if (node) {
      node.port.onmessage = null
    }
    node?.disconnect()
    node = null
    for (const track of stream?.getTracks() ?? []) {
      track.stop()
    }
    stream = null
    await ctx?.close()
    ctx = null
    reset()
    preroll = []
  }

  const setListening = (value: boolean) => {
    listening = value
    if (!value) {
      reset()
      preroll = []
    }
  }

  return { start, pause, destroy, setListening }
}
