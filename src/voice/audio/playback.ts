/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Gapless playback queue (THU-684).
 *
 * Schedules TTS audio chunks back-to-back on a Web Audio graph routed to the
 * **default output** — that placement is what lets the browser/OS AEC use our
 * playout as its echo reference (so the mic doesn't hear the assistant and
 * self-trigger barge-in), even when the PCM was produced natively. `flush()`
 * stops everything immediately (<100 ms) for barge-in.
 */
import type { AudioChunk } from '@/voice/engine/types'

export type PlaybackQueue = {
  /** Schedule a chunk to play after whatever is already queued. */
  enqueue: (chunk: AudioChunk) => void
  /** Stop and drop all scheduled/playing audio immediately (barge-in). */
  flush: () => void
  /** Permanently release the audio graph — closes the owned AudioContext. */
  close: () => void
  /** Current output RMS (~[0,1]) of what's playing, for the reactive waveform;
   *  0 when nothing is queued. */
  getLevel: () => number
  readonly isPlaying: boolean
  readonly audioContext: AudioContext
}

export const createPlaybackQueue = (audioContext?: AudioContext): PlaybackQueue => {
  const ctx = audioContext ?? new AudioContext()
  const ownsCtx = !audioContext // only close a context we created
  const active = new Set<AudioBufferSourceNode>()
  // Tap the output so the waveform can react to the assistant's actual voice.
  // Sources route through the analyser to `destination`, which passes audio
  // through unchanged — so the browser/OS AEC still sees our playout as its echo
  // reference (see the module note), it just also feeds level readings.
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.connect(ctx.destination)
  const levelBuf = new Float32Array(analyser.fftSize)
  let nextStartTime = 0
  let closed = false

  const enqueue = (chunk: AudioChunk) => {
    void ctx.resume() // no-op once running; needed after the user-gesture start
    const buffer = ctx.createBuffer(1, chunk.pcm.length, chunk.sampleRate)
    buffer.copyToChannel(new Float32Array(chunk.pcm), 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(analyser)
    const startAt = Math.max(ctx.currentTime, nextStartTime)
    source.start(startAt)
    nextStartTime = startAt + buffer.duration
    active.add(source)
    source.onended = () => active.delete(source)
  }

  const getLevel = (): number => {
    if (active.size === 0) {
      return 0 // nothing playing — don't report residual analyser data
    }
    analyser.getFloatTimeDomainData(levelBuf)
    let sum = 0
    for (let i = 0; i < levelBuf.length; i++) {
      sum += levelBuf[i] * levelBuf[i]
    }
    return Math.sqrt(sum / levelBuf.length)
  }

  const flush = () => {
    for (const source of active) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // already stopped/ended — fine
      }
      source.disconnect()
    }
    active.clear()
    nextStartTime = 0
  }

  const close = () => {
    if (closed) {
      return
    } // ctx.close() throws if called twice
    closed = true
    flush()
    if (ownsCtx) {
      void ctx.close()
    }
  }

  return {
    enqueue,
    flush,
    close,
    getLevel,
    get isPlaying() {
      return active.size > 0
    },
    audioContext: ctx,
  }
}
