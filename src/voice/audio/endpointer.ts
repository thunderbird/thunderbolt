/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Energy-VAD endpointing state machine (THU-684) — the pure logic behind the mic
 * gate, split out of `vad.ts` so it's unit-testable without `getUserMedia` /
 * `AudioWorklet`. Feed it 16 kHz mono frames via `processFrame`; it fires
 * `onSpeechStart` once speech is sustained (barge-in), `onUtterance` with the
 * committed audio after a trailing-silence window, and `onMisfire` for blips too
 * short to be real speech.
 */
import { concatFrames } from '@/voice/engine/audio-engine'

export type EndpointerHandlers = {
  /** Sustained speech confirmed (the barge-in trigger). Fires once per utterance,
   *  at the same threshold that guarantees a commit — so acting on it (cutting off
   *  the assistant) always yields a following `onUtterance`, never dead air. */
  onSpeechStart?: () => void
  /** A committed utterance (mono Float32Array @ 16 kHz) ready for transcription. */
  onUtterance: (audio: Float32Array) => void
  /** Speech started but was too short to be a real utterance. */
  onMisfire?: () => void
  /** Per-frame mic RMS [0,1] — drives the live waveform. */
  onLevel?: (rms: number) => void
}

/** Frames are 512 samples (~32 ms) — set by the capture worklet. */
export const speechRmsThreshold = 0.015 // normalized [-1,1] amplitude; tune for the mic
// ~256 ms of speech. Doubles as the barge-in gate: firing barge-in any earlier
// than the commit threshold would let a brief blip cut the assistant off and then
// fail to commit (dead air). More sustained frames = more robust against residual
// echo while the assistant speaks; raise it (or `speechRmsThreshold`) if the
// assistant interrupts itself.
export const minSpeechFrames = 8
// ~1.4 s of trailing silence ends the turn. Long enough to think mid-sentence
// without firing on a natural pause; a streaming STT with semantic endpointing
// would let us shorten this later.
export const endSilenceFrames = 45
const prerollFrames = 4 // keep a little audio before onset so we don't clip it

export const rms = (frame: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i]
  }
  return Math.sqrt(sum / frame.length)
}

export type Endpointer = {
  /** Consume one captured frame. */
  processFrame: (frame: Float32Array) => void
  /** Drop all in-progress state incl. preroll — used when the gate stops listening. */
  clear: () => void
}

export const createEndpointer = (handlers: EndpointerHandlers): Endpointer => {
  let speaking = false
  let collected: Float32Array[] = []
  let preroll: Float32Array[] = []
  let silenceRun = 0
  let speechFrames = 0 // frames actually above threshold (excludes trailing silence)
  let bargeInFired = false // barge-in signalled once for the current utterance

  const reset = () => {
    speaking = false
    collected = []
    silenceRun = 0
    speechFrames = 0
    bargeInFired = false
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
      }
      collected.push(frame)
      silenceRun = 0
      speechFrames++
      // Barge-in fires only once the utterance is guaranteed to commit
      // (minSpeechFrames sustained), so cutting the assistant off always yields a
      // replacement turn — never dead air — and brief residual-echo blips can't
      // trigger it. The audio that triggered it stays buffered and still commits.
      if (!bargeInFired && speechFrames >= minSpeechFrames) {
        bargeInFired = true
        handlers.onSpeechStart?.()
      }
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

  const clear = () => {
    reset()
    preroll = []
  }

  return { processFrame, clear }
}
