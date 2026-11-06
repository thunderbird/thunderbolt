/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The platform-swappable STT+TTS backend (THU-700).
 *
 * Everything else in the voice loop — mic capture, VAD, turn detection,
 * playback, barge-in — is shared webview code that talks only to this
 * interface. Two implementations exist, both HTTP-based and both built on the
 * shared `createAudioEngine` orchestration ({@link ./audio-engine}); they
 * differ only in transport. The default is the Thunderbolt engine
 * ({@link ./thunderbolt-engine}), which reaches Tinfoil's enclave-private
 * OpenAI-compatible `/v1/audio/*` endpoints through the attested `/tinfoil`
 * HPKE proxy. The alternative points at a user-supplied OpenAI-compatible
 * endpoint over a plain authenticated fetch
 * ({@link ./openai-compatible-engine}) and is only reachable when the
 * `experimental_feature_voice` flag is on — see {@link ./router} for the
 * selection rule. Swapping the engine never touches the realtime loop: an
 * engine only has to forward the per-turn `AbortSignal` to its transport, so
 * barge-in cancels an in-flight request identically on either.
 */

/** Mono PCM at 16 kHz (the rate STT and VAD expect), as produced by capture. */
export type PcmFrame = Float32Array

/** A synthesized audio chunk headed for the shared playback queue. */
export type AudioChunk = {
  pcm: Float32Array
  sampleRate: number
}

/** An STT result. `isFinal` marks the committed transcript for a turn. */
export type Transcript = {
  text: string
  isFinal: boolean
}

/**
 * Warm-up progress, per model. Nothing emits it today: `createAudioEngine`
 * ignores `load`'s callback, and neither HTTP engine has files to fetch.
 */
export type EngineLoadProgress = {
  model: string
  loaded: number
  total: number
}

export type VoiceEngine = {
  /** Stable engine identifier: `thunderbolt` or `openai-compatible`. */
  readonly id: string
  /**
   * Warm up before the first turn — the Thunderbolt engine primes enclave
   * attestation here; the OpenAI-compatible one has nothing to do. Idempotent,
   * since the attested client is cached ({@link ../../ai/tinfoil-client}).
   */
  load: (onProgress?: (progress: EngineLoadProgress) => void) => Promise<void>
  /**
   * Consume 16 kHz mono PCM frames and yield transcripts, `isFinal` marking the
   * committed one. Both engines transcribe a whole utterance in one batch
   * request, so today they yield only the final result. Aborting stops the
   * in-flight request (barge-in).
   */
  transcribe: (audio: AsyncIterable<PcmFrame>, signal?: AbortSignal) => AsyncIterable<Transcript>
  /**
   * Streaming synthesis: consume already-aggregated text chunks (see
   * {@link ../aggregator}), yield audio for playback. Aborting cancels
   * in-flight synthesis (barge-in).
   */
  synthesize: (text: AsyncIterable<string>, signal?: AbortSignal) => AsyncIterable<AudioChunk>
  /** Release engine-held resources (`createAudioEngine` closes its decode `AudioContext`). */
  dispose: () => void
}
