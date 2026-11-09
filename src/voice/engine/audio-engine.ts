/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared OpenAI-compatible audio engine (THU-718).
 *
 * The STT/TTS request/response shapes (`/audio/transcriptions`, `/audio/speech`)
 * are identical across providers — only the *transport* differs: the Thunderbolt
 * engine tunnels through the attested `/tinfoil` HPKE proxy, while a custom or
 * self-hosted engine does a plain authenticated fetch. This factory owns the
 * common orchestration + audio codec; each engine just supplies a `transport`.
 */
import type { AudioChunk, PcmFrame, Transcript, VoiceEngine } from './types'

/** Sample rate the capture worklet emits and STT expects. */
export const sttSampleRate = 16000

/** Sends one request to an `/audio/*` path and returns the raw Response (does
 *  NOT throw on non-2xx — the factory inspects status + body itself). The
 *  per-turn `signal` must be forwarded to the underlying fetch so an aborted turn
 *  (barge-in supersede / Exit voice mode) cancels the in-flight request rather
 *  than running it to completion against the provider. */
export type AudioTransport = (
  path: string,
  body: BodyInit,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<Response>

export type AudioEngineOptions = {
  id: string
  transport: AudioTransport
  sttModel: string
  ttsModel: string
  ttsVoice: string
  /** Style/emotion steering (vLLM-Omni extension) — omit for stricter servers. */
  ttsInstructions?: string
  /** wav/mp3/… — `decodeAudioData` handles whatever comes back. Defaults to wav. */
  ttsFormat?: string
  ttsSpeed?: number
  /**
   * Stream raw 16-bit mono PCM and play it as it arrives, instead of waiting for
   * the whole file. Overrides `ttsFormat`. A vLLM-Omni extension: raw PCM has no
   * header, so `sampleRate` must be the rate the server actually emits.
   */
  ttsStream?: { sampleRate: number }
  /** Optional warmup on `load()` (e.g. prime enclave attestation). */
  warm?: () => Promise<void>
}

/** Encode mono 16 kHz float PCM as a 16-bit WAV for the transcription endpoint. */
export const encodeWav = (samples: Float32Array, sampleRate: number): Blob => {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i))
    }
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export const concatFrames = (frames: PcmFrame[]): Float32Array => {
  const merged = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  frames.reduce((offset, f) => (merged.set(f, offset), offset + f.length), 0)
  return merged
}

const errorText = async (res: Response): Promise<string> => `${res.status} ${await res.text().catch(() => '')}`.trim()

/** Join two byte arrays into a new array, preserving their order. */
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Smallest streamed piece handed to playback, so a burst of tiny network reads
 *  does not become a burst of tiny audio buffers. */
const minStreamChunkSeconds = 0.1

/**
 * Decode a streamed body of 16-bit little-endian mono PCM into float chunks as
 * the bytes arrive. A read can end mid-sample, so an odd trailing byte is
 * carried into the next read.
 */
export const readPcm16Stream = async function* (
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
): AsyncIterable<AudioChunk> {
  const minSamples = Math.round(sampleRate * minStreamChunkSeconds)
  const reader = body.getReader()
  let carry: Uint8Array = new Uint8Array(0)
  let pending: Float32Array[] = []
  let pendingSamples = 0
  const takePending = (): AudioChunk => {
    const pcm = concatFrames(pending)
    pending = []
    pendingSamples = 0
    return { pcm, sampleRate }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const bytes = carry.length > 0 ? concatBytes(carry, value) : value
      const usable = bytes.length - (bytes.length % 2)
      carry = bytes.slice(usable)
      if (usable === 0) {
        continue
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, usable)
      const samples = new Float32Array(usable / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 0x8000
      }
      pending.push(samples)
      pendingSamples += samples.length
      if (pendingSamples >= minSamples) {
        yield takePending()
      }
    }
    if (pendingSamples > 0) {
      yield takePending()
    }
  } finally {
    // Stops the download when the consumer stops early (barge-in). On a stream
    // that already failed, cancel rejects with the error that is propagating.
    void reader.cancel().catch(() => {})
  }
}

export const createAudioEngine = (opts: AudioEngineOptions): VoiceEngine => {
  const ttsFormat = opts.ttsFormat ?? 'wav'
  let decodeCtx: AudioContext | null = null

  const load = async () => {
    await opts.warm?.()
  }

  const transcribe = async function* (audio: AsyncIterable<PcmFrame>, signal?: AbortSignal): AsyncIterable<Transcript> {
    const frames: PcmFrame[] = []
    for await (const frame of audio) {
      if (signal?.aborted) {
        return
      }
      frames.push(frame)
    }
    if (frames.length === 0) {
      return
    }
    // The session feeds one already-merged utterance frame; skip the redundant
    // full-length copy in that common case.
    const merged = frames.length === 1 ? frames[0] : concatFrames(frames)
    const form = new FormData()
    form.append('file', encodeWav(merged, sttSampleRate), 'utterance.wav')
    form.append('model', opts.sttModel)
    // Greedy decoding: transcription wants the most likely words, not variety.
    form.append('temperature', '0')
    const res = await opts.transport('/audio/transcriptions', form, undefined, signal)
    if (!res.ok) {
      throw new Error(`STT failed: ${await errorText(res)}`)
    }
    const data = (await res.json()) as { text?: string }
    if (signal?.aborted) {
      return
    }
    yield { text: (data.text ?? '').trim(), isFinal: true }
  }

  const synthesize = async function* (text: AsyncIterable<string>, signal?: AbortSignal): AsyncIterable<AudioChunk> {
    const stream = opts.ttsStream
    if (!stream) {
      decodeCtx ??= new AudioContext()
    }
    for await (const chunk of text) {
      if (signal?.aborted) {
        return
      }
      const payload: Record<string, unknown> = {
        model: opts.ttsModel,
        input: chunk,
        voice: opts.ttsVoice,
        response_format: stream ? 'pcm' : ttsFormat,
      }
      if (stream) {
        // vLLM-Omni ≥ 0.24 answers a bare `stream: true` with SSE events of
        // base64 audio; `stream_format: 'audio'` asks for the raw bytes.
        payload.stream = true
        payload.stream_format = 'audio'
      }
      if (opts.ttsSpeed !== undefined) {
        payload.speed = opts.ttsSpeed
      }
      if (opts.ttsInstructions) {
        payload.instructions = opts.ttsInstructions
      }
      const res = await opts.transport(
        '/audio/speech',
        JSON.stringify(payload),
        { 'content-type': 'application/json' },
        signal,
      )
      if (!res.ok) {
        throw new Error(`TTS failed: ${await errorText(res)}`)
      }
      if (stream) {
        if (!res.body) {
          throw new Error('TTS failed: streamed response has no body')
        }
        // A server that ignores `stream_format` answers with SSE or JSON text,
        // which decoded as PCM plays as loud static.
        const contentType = res.headers.get('content-type') ?? ''
        if (/^(text\/|application\/json)/.test(contentType)) {
          await res.body.cancel()
          throw new Error(`TTS failed: expected raw audio, got ${contentType}`)
        }
        for await (const piece of readPcm16Stream(res.body, stream.sampleRate)) {
          if (signal?.aborted) {
            return
          }
          yield piece
        }
        continue
      }
      // Re-check before decoding: a response that resolved right as the turn was
      // aborted must not be decoded, and dispose() nulls decodeCtx concurrently.
      if (signal?.aborted || !decodeCtx) {
        return
      }
      const decoded = await decodeCtx.decodeAudioData(await res.arrayBuffer())
      if (signal?.aborted) {
        return
      }
      yield { pcm: decoded.getChannelData(0).slice(), sampleRate: decoded.sampleRate }
    }
  }

  const dispose = () => {
    void decodeCtx?.close()
    decodeCtx = null
  }

  return { id: opts.id, load, transcribe, synthesize, dispose }
}
