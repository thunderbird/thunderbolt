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
  readonly isPlaying: boolean
  readonly audioContext: AudioContext
}

export const createPlaybackQueue = (audioContext?: AudioContext): PlaybackQueue => {
  const ctx = audioContext ?? new AudioContext()
  const ownsCtx = !audioContext // only close a context we created
  const active = new Set<AudioBufferSourceNode>()
  let nextStartTime = 0
  let closed = false

  const enqueue = (chunk: AudioChunk) => {
    void ctx.resume() // no-op once running; needed after the user-gesture start
    const buffer = ctx.createBuffer(1, chunk.pcm.length, chunk.sampleRate)
    buffer.copyToChannel(new Float32Array(chunk.pcm), 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime, nextStartTime)
    source.start(startAt)
    nextStartTime = startAt + buffer.duration
    active.add(source)
    source.onended = () => active.delete(source)
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
    get isPlaying() {
      return active.size > 0
    },
    audioContext: ctx,
  }
}
