/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The platform-swappable STT+TTS backend (THU-700).
 *
 * Everything else in the voice loop — mic capture, VAD, turn detection,
 * playback, barge-in — is shared webview code that talks only to this
 * interface. Two implementations exist: an in-webview JS engine (web +
 * Windows) and a native `sherpa-onnx` engine over Tauri IPC (macOS; Linux
 * fallback). Swapping the engine never touches the realtime loop, which is
 * what makes barge-in parity automatic across surfaces.
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

/** First-run model download / warm-up progress, per model file. */
export type EngineLoadProgress = {
  model: string
  loaded: number
  total: number
}

export type VoiceEngine = {
  /** Stable identifier for logging/telemetry, e.g. `webview` or `sherpa`. */
  readonly id: string
  /** Load and warm the models. Idempotent — safe to call more than once. */
  load: (onProgress?: (progress: EngineLoadProgress) => void) => Promise<void>
  /**
   * Streaming transcription: consume 16 kHz mono PCM frames, yield partial
   * then final transcripts. Aborting stops decoding promptly (barge-in).
   */
  transcribe: (audio: AsyncIterable<PcmFrame>, signal?: AbortSignal) => AsyncIterable<Transcript>
  /**
   * Streaming synthesis: consume already-aggregated text chunks (see
   * {@link ../aggregator}), yield audio for playback. Aborting cancels
   * in-flight synthesis (barge-in).
   */
  synthesize: (text: AsyncIterable<string>, signal?: AbortSignal) => AsyncIterable<AudioChunk>
  /** Release models/sessions. */
  dispose: () => void
}
