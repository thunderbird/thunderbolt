/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice session orchestrator (THU-688) — the shared realtime loop.
 *
 * Wires the VAD gate → engine STT → a `reply` function → the sentence
 * aggregator → engine TTS → playback. It's engine- and chat-agnostic: the
 * `reply` callback is where the app plugs in the real chat/LLM flow (or an echo,
 * for testing). Nothing here is platform-specific, so web and desktop share it
 * verbatim — only the injected `VoiceEngine` differs.
 *
 * Full-duplex barge-in: the mic/VAD keeps running while the assistant thinks and
 * speaks (see `setState`), so sustained user speech (`onSpeechStart`) cuts the
 * reply off immediately — the aborted turn's audio keeps accumulating in the VAD
 * and commits as the next turn. This leans on the browser's echo cancellation to
 * keep the assistant's own playback from self-triggering; `minSpeechFrames` in the
 * endpointer is the echo-robustness knob if it interrupts itself.
 *
 * Not yet layered on: Smart Turn semantic endpointing (VAD silence endpointing
 * is used for now).
 */
import { type ContentPartsState, parseContentPartsIncremental } from '@/ai/widget-parser'
import { SentenceAggregator } from '@/voice/aggregator'
import { type Earcons, createEarcons } from '@/voice/audio/earcon'
import { createPlaybackQueue } from '@/voice/audio/playback'
import { createVadGate } from '@/voice/audio/vad'
import type { VoiceEngine } from '@/voice/engine/types'
import { partsToSpeech, toSpeakable } from '@/voice/speakable'
import { isHallucinatedTranscript } from '@/voice/transcript-filter'

export type SessionState = 'idle' | 'listening' | 'thinking' | 'speaking'

/** Produces the assistant's reply text as a token stream for the given user turn. */
export type ReplyFn = (userText: string, signal: AbortSignal) => AsyncIterable<string>

export type VoiceSessionOptions = {
  engine: VoiceEngine
  reply: ReplyFn
  onState?: (state: SessionState) => void
  onTranscript?: (text: string, role: 'user' | 'assistant') => void
  onError?: (error: unknown) => void
  /** Live mic level [0,1] per frame while listening — for the reactive waveform. */
  onLevel?: (level: number) => void
  /**
   * Audible cues for "mic is open" and "heard you" (THU-856). Defaults to real
   * tones on the playback context; injected in tests, which have no AudioContext.
   */
  earcons?: Earcons
}

export type VoiceSession = {
  start: () => Promise<void>
  stop: () => Promise<void>
  readonly state: SessionState
  /** Current TTS output RMS (~[0,1]) for the speaking-state waveform. */
  getOutputLevel: () => number
}

const singleFrame = async function* (audio: Float32Array): AsyncIterable<Float32Array> {
  yield audio
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const createVoiceSession = (options: VoiceSessionOptions): VoiceSession => {
  const { engine, reply, onState, onTranscript, onError, onLevel } = options
  const playback = createPlaybackQueue()
  const earcons = options.earcons ?? createEarcons(playback.audioContext)
  let state: SessionState = 'idle'
  let turn: AbortController | null = null
  let vadGate: Awaited<ReturnType<typeof createVadGate>> | null = null
  // Guards a stop() that lands mid-startup: start() awaits engine.load() and gate
  // creation before assigning vadGate, so a stop during 'Starting…' would no-op
  // (vadGate still null) and then start() would resume and open an orphaned mic
  // with no session reference. start() checks this after each await and tears down.
  let stopped = false

  const setState = (next: SessionState) => {
    state = next
    // Full-duplex for barge-in: keep the mic/VAD running while thinking/speaking
    // so the user can talk over the assistant (onSpeechStart → barge-in below).
    // Only 'idle' (session stopped) silences the gate. Relies on echo cancellation
    // so the assistant's own audio doesn't self-trigger a barge-in.
    vadGate?.setListening(next !== 'idle')
    onState?.(next)
  }

  /**
   * Barge-in: sustained user speech while the assistant is thinking or speaking
   * cuts the reply off at once — abort the turn (stops STT/LLM/TTS), flush queued
   * audio (<100 ms), and drop back to listening. The VAD keeps this same utterance
   * buffered, so it commits via onUtterance as the next turn (no lost onset).
   */
  const onSpeechStart = () => {
    if (state !== 'thinking' && state !== 'speaking') {
      return
    }
    turn?.abort()
    playback.flush()
    setState('listening')
  }

  const onUtterance = async (audio: Float32Array) => {
    turn?.abort() // supersede any in-flight turn
    const ac = new AbortController()
    turn = ac
    // Acknowledge here rather than after transcription: the endpointer only
    // commits sustained speech, so this is already past the blip filter, and a
    // cue that waits on the STT round trip arrives too late to read as a
    // response to what the user just did. The cost is chiming for the rare
    // noise burst that survives endpointing and is then dropped as a Whisper
    // hallucination below — a wrong "heard you" beats a second of silence.
    earcons.captured()
    try {
      setState('thinking')

      let userText = ''
      for await (const t of engine.transcribe(singleFrame(audio), ac.signal)) {
        userText = t.text
      }
      if (ac.signal.aborted) {
        return
      }
      userText = userText.trim()
      // Drop empty turns and Whisper silence-hallucinations ("Thank you", "Bye")
      // so background noise the VAD misfired on never becomes a phantom turn.
      if (isHallucinatedTranscript(userText)) {
        setState('listening')
        return
      }
      onTranscript?.(userText, 'user')

      // reply tokens → widget-strip → aggregator → sanitize → synthesizable chunks.
      const aggregator = new SentenceAggregator()
      let assistantText = ''
      // Parse the accumulated reply into content parts FIRST and feed only the
      // clean speech source (text + widget announcements, never widget internals)
      // into the aggregator. Doing this pre-aggregation is what stops a widget tag
      // full of punctuation (e.g. an `ask`/quiz) from being split into fragments
      // whose guts leak to TTS. Each aggregated sentence is then sanitized
      // (markdown/latex/emoji) before synthesis.
      const chunks = (async function* () {
        let accumulated = ''
        let emitted = ''
        // Thread the incremental parser's state so each streamed token parses
        // only the appended tail, not the whole growing string (avoids O(n²)).
        let parseState: ContentPartsState | null = null
        const speechSoFar = (): string => {
          const { parts, state } = parseContentPartsIncremental(accumulated, parseState)
          parseState = state
          return partsToSpeech(parts)
        }
        const pushClean = function* (full: string) {
          // Content parts only grow at the tail; guard the rare reinterpretation
          // (a trailing "<" or open "【" that resolves later) so we never corrupt
          // the aggregator's buffer with a non-monotonic rewrite.
          if (!full.startsWith(emitted)) {
            emitted = full
            return
          }
          const delta = full.slice(emitted.length)
          emitted = full
          if (!delta) {
            return
          }
          for (const chunk of aggregator.push(delta)) {
            const speakable = toSpeakable(chunk)
            if (speakable) {
              yield speakable
            }
          }
        }
        for await (const token of reply(userText, ac.signal)) {
          if (ac.signal.aborted) {
            return
          }
          assistantText += token
          accumulated += token
          yield* pushClean(speechSoFar())
        }
        yield* pushClean(speechSoFar())
        for (const chunk of aggregator.flush()) {
          const speakable = toSpeakable(chunk)
          if (speakable) {
            yield speakable
          }
        }
      })()

      setState('speaking')
      for await (const audioChunk of engine.synthesize(chunks, ac.signal)) {
        if (ac.signal.aborted) {
          return
        }
        playback.enqueue(audioChunk)
      }
      if (ac.signal.aborted) {
        return
      }
      if (assistantText.trim().length > 0) {
        onTranscript?.(assistantText.trim(), 'assistant')
      }
      // Stay in `speaking` until the queued audio has actually finished playing —
      // synthesis enqueues faster than playback drains, and flipping to `listening`
      // early makes the VAD treat the assistant's own audio as a user turn.
      while (playback.isPlaying && !ac.signal.aborted) {
        await tick(80)
      }
      if (ac.signal.aborted) {
        return
      }
      setState('listening')
    } catch (error) {
      if (ac.signal.aborted) {
        return
      }
      onError?.(error)
      setState('listening')
    }
  }

  const start = async () => {
    stopped = false
    const gate = createVadGate({ onSpeechStart, onUtterance, onLevel })
    // Born muted, because racing the two halves means the mic can go live while the
    // engine is still loading. The gate pumps frames to the endpointer the instant
    // `gate.start()` resolves, so an eager user speaking during attestation would
    // commit an utterance against an engine that can't transcribe yet — and the
    // `setState('listening')` below would then stomp that in-flight turn and chime
    // the invitation over it. `setState('listening')` unmutes once both are ready.
    gate.setListening(false)
    // Concurrently, because they have nothing to do with each other: loading the
    // engine is a network round trip (the hosted engine primes Tinfoil enclave
    // attestation), and opening the mic is a permission prompt. Run in sequence
    // the user waits for the sum of the two, and on a first run doesn't even see
    // the prompt until attestation comes back.
    // Settled rather than `all`: racing means either half can fail with the other
    // still in flight, and tearing down mid-flight destroys a gate that hasn't
    // acquired the mic yet — a no-op. The pending `getUserMedia` then resolves
    // into a live mic nothing holds a reference to, because `vadGate` is never
    // assigned and the caller's `stop()` only destroys that. Waiting for both to
    // settle means destroy always runs against the gate's final state.
    const outcomes = await Promise.allSettled([engine.load(), gate.start()])
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failure) {
      await gate.destroy()
      throw failure.reason
    }
    if (stopped) {
      await gate.destroy()
      return
    }
    vadGate = gate
    setState('listening')
    // The one transition the user cannot anticipate. Every other route back to
    // 'listening' follows something they can already perceive — the assistant's
    // own voice stopping, or their own barge-in — so re-announcing those would
    // be noise on every single turn.
    earcons.listening()
  }

  const stop = async () => {
    stopped = true
    turn?.abort()
    // Release every audio resource: VAD mic/ctx, the playback ctx, and the
    // engine's decode ctx. Missing any leaks an AudioContext per start/stop and
    // the browser cap (~6) breaks voice after a few toggles.
    playback.close()
    engine.dispose()
    await vadGate?.destroy()
    vadGate = null
    setState('idle')
  }

  return {
    start,
    stop,
    get state() {
      return state
    },
    getOutputLevel: () => playback.getLevel(),
  }
}
