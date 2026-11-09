/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type AudioTransport, createAudioEngine, readPcm16Stream } from './audio-engine'

/** Little-endian 16-bit PCM bytes for the given integer samples. */
const pcm16 = (samples: number[]): Uint8Array => {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  return new Uint8Array(view.buffer)
}

const streamOf = (reads: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      for (const read of reads) {
        controller.enqueue(read)
      }
      controller.close()
    },
  })

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

const samplesOf = (chunks: { pcm: Float32Array }[]): number[] =>
  chunks.flatMap((chunk) => Array.from(chunk.pcm, (s) => Math.round(s * 0x8000)))

describe('readPcm16Stream', () => {
  it('decodes 16-bit little-endian samples to floats', async () => {
    const chunks = await collect(readPcm16Stream(streamOf([pcm16([0, 16384, -16384, -32768])]), 10))
    expect(Array.from(chunks[0].pcm)).toEqual([0, 0.5, -0.5, -1])
    expect(chunks[0].sampleRate).toBe(10)
  })

  it('carries a sample split across two reads', async () => {
    const bytes = pcm16([1000, -2000, 3000])
    const chunks = await collect(readPcm16Stream(streamOf([bytes.slice(0, 3), bytes.slice(3)]), 10))
    expect(samplesOf(chunks)).toEqual([1000, -2000, 3000])
  })

  it('merges tiny reads into pieces of at least 100 ms, then flushes the rest', async () => {
    // 100 samples/s → 10 samples per 100 ms piece.
    const reads = Array.from({ length: 25 }, (_, i) => pcm16([i]))
    const chunks = await collect(readPcm16Stream(streamOf(reads), 100))
    expect(chunks.map((chunk) => chunk.pcm.length)).toEqual([10, 10, 5])
    expect(samplesOf(chunks)).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(pcm16([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])),
      cancel: () => {
        cancelled = true
      },
    })
    for await (const _chunk of readPcm16Stream(body, 100)) {
      break
    }
    expect(cancelled).toBe(true)
  })
})

describe('createAudioEngine streaming synthesis', () => {
  it('requests streamed PCM and yields audio from the response body', async () => {
    const payloads: Record<string, unknown>[] = []
    const transport: AudioTransport = async (_path, body) => {
      payloads.push(JSON.parse(String(body)))
      return new Response(streamOf([pcm16([8192, -8192])]))
    }
    const engine = createAudioEngine({
      id: 'test',
      transport,
      sttModel: 'stt',
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsSpeed: 1,
      ttsStream: { sampleRate: 24_000 },
    })
    const text = (async function* () {
      yield 'Hello there.'
    })()
    const chunks = await collect(engine.synthesize(text))
    expect(payloads[0]).toMatchObject({
      input: 'Hello there.',
      response_format: 'pcm',
      stream: true,
      stream_format: 'audio',
      speed: 1,
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].sampleRate).toBe(24_000)
    expect(Array.from(chunks[0].pcm)).toEqual([0.25, -0.25])
  })

  it('sends one streamed request per text chunk and plays them in order', async () => {
    const inputs: string[] = []
    const transport: AudioTransport = async (_path, body) => {
      const { input } = JSON.parse(String(body)) as { input: string }
      inputs.push(input)
      return new Response(streamOf([pcm16([inputs.length * 1000])]))
    }
    const engine = createAudioEngine({
      id: 'test',
      transport,
      sttModel: 'stt',
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsStream: { sampleRate: 24_000 },
    })
    const text = (async function* () {
      yield 'First.'
      yield 'Second.'
    })()
    const chunks = await collect(engine.synthesize(text))
    expect(inputs).toEqual(['First.', 'Second.'])
    expect(samplesOf(chunks)).toEqual([1000, 2000])
  })

  it('rejects a text response instead of playing it as noise', async () => {
    let cancelled = false
    const sse = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode('event: speech.audio.delta\ndata: {}\n\n')),
      cancel: () => {
        cancelled = true
      },
    })
    const transport: AudioTransport = async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    const engine = createAudioEngine({
      id: 'test',
      transport,
      sttModel: 'stt',
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsStream: { sampleRate: 24_000 },
    })
    const text = (async function* () {
      yield 'Hi.'
    })()
    await expect(collect(engine.synthesize(text))).rejects.toThrow('expected raw audio, got text/event-stream')
    expect(cancelled).toBe(true)
  })

  it('surfaces the error body of a rejected streaming request', async () => {
    const transport: AudioTransport = async () => new Response('bad voice', { status: 400 })
    const engine = createAudioEngine({
      id: 'test',
      transport,
      sttModel: 'stt',
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsStream: { sampleRate: 24_000 },
    })
    const text = (async function* () {
      yield 'Hi.'
    })()
    await expect(collect(engine.synthesize(text))).rejects.toThrow('TTS failed: 400 bad voice')
  })
})

describe('createAudioEngine transcription', () => {
  it('asks for greedy decoding', async () => {
    const forms: FormData[] = []
    const transport: AudioTransport = async (_path, body) => {
      forms.push(body as FormData)
      return Response.json({ text: ' hello ' })
    }
    const engine = createAudioEngine({ id: 'test', transport, sttModel: 'stt', ttsModel: 'tts', ttsVoice: 'voice' })
    const audio = (async function* () {
      yield new Float32Array(160)
    })()
    const transcripts = await collect(engine.transcribe(audio))
    expect(forms[0].get('model')).toBe('stt')
    expect(forms[0].get('temperature')).toBe('0')
    expect(transcripts).toEqual([{ text: 'hello', isFinal: true }])
  })
})
