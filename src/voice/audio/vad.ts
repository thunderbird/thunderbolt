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
 * `getUserMedia` runs with echo cancellation on. For barge-in the session keeps
 * the gate running *during* playback, so browser AEC is the only thing stopping
 * the assistant's own audio from self-triggering — `onSpeechStart` deliberately
 * waits for sustained speech (see the endpointer) to stay robust against residual
 * echo. This file owns only the mic/worklet plumbing; the endpointing state
 * machine lives in `./endpointer` so it can be unit-tested without a mic.
 */
import { MediaDevicesUnavailableError } from '@/voice/voice-error'
import { type EndpointerHandlers, createEndpointer } from './endpointer'

/** Handlers for the mic gate — same shape the endpointer consumes. */
export type VadHandlers = EndpointerHandlers

export type VadGate = {
  start: () => Promise<void>
  pause: () => Promise<void>
  destroy: () => Promise<void>
  /** Gate frame processing. Paused = no self-triggering while the assistant
   *  speaks (half-duplex). */
  setListening: (value: boolean) => void
}

const aecConstraints: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}

export const createVadGate = (handlers: VadHandlers): VadGate => {
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let listening = true
  const endpointer = createEndpointer(handlers)

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
        endpointer.processFrame(event.data)
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
    endpointer.clear()
  }

  const setListening = (value: boolean) => {
    listening = value
    if (!value) {
      endpointer.clear()
    }
  }

  return { start, pause, destroy, setListening }
}
