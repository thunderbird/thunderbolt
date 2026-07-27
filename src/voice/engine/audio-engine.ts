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
    decodeCtx ??= new AudioContext()
    for await (const chunk of text) {
      if (signal?.aborted) {
        return
      }
      const payload: Record<string, unknown> = {
        model: opts.ttsModel,
        input: chunk,
        voice: opts.ttsVoice,
        response_format: ttsFormat,
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
