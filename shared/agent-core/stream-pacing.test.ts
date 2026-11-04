/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AiSdkChunk } from './pi-to-aisdk-stream.ts'
import { paceStreamChunks, type ArrivingChunk } from './stream-pacing.ts'

const words = (text: string): string | null => /^\S+\s+/.exec(text)?.[0] ?? null

/** Feed already-arrived chunks through the same presentation transform as the Pi stream. */
const source = (...chunks: ArrivingChunk[]): ReadableStream<ArrivingChunk> =>
  new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })

/** Collect a completed readable stream without relying on browser-only helpers. */
const collect = async (stream: ReadableStream<AiSdkChunk>): Promise<AiSdkChunk[]> => {
  const result: AiSdkChunk[] = []
  for await (const chunk of stream) {
    result.push(chunk)
  }
  return result
}

describe('paceStreamChunks', () => {
  it('emits the first received word immediately, then drains before terminal and tool events', async () => {
    const nextWord = Promise.withResolvers<void>()
    const clock = { time: 0 }
    const waits: number[] = []
    const reader = source(
      { chunk: { type: 'text-delta', id: 'text', delta: 'Hello world.' }, receivedAt: 0 },
      { chunk: { type: 'text-end', id: 'text' }, receivedAt: 0 },
      { chunk: { type: 'tool-input-start', toolCallId: 'call', toolName: 'search' }, receivedAt: 0 },
      { chunk: { type: 'finish' }, receivedAt: 0 },
    )
      .pipeThrough(
        paceStreamChunks({ chunking: words, delayInMs: 10 }, undefined, {
          now: () => clock.time,
          wait: async (delay) => {
            waits.push(delay)
            await nextWord.promise
            clock.time += delay
          },
        }),
      )
      .getReader()

    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'text', delta: 'Hello ' })
    nextWord.resolve()
    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'text', delta: 'world.' })
    expect((await reader.read()).value).toEqual({ type: 'text-end', id: 'text' })
    expect((await reader.read()).value?.type).toBe('tool-input-start')
    expect((await reader.read()).value?.type).toBe('finish')
    expect((await reader.read()).done).toBe(true)
    expect(waits).toEqual([10])
  })

  it.each(['text-delta', 'reasoning-delta'] as const)(
    'caps the lag of a large %s burst and keeps all text',
    async (type) => {
      const clock = { time: 0 }
      const delta = 'word '.repeat(400)
      const output = await collect(
        source({ chunk: { type, id: 'part', delta }, receivedAt: 0 }).pipeThrough(
          paceStreamChunks({ chunking: words, delayInMs: 10 }, undefined, {
            now: () => clock.time,
            wait: async (delay) => {
              clock.time += delay
            },
          }),
        ),
      )

      expect(output.length).toBeGreaterThan(1)
      expect(output.length).toBeLessThanOrEqual(17)
      expect(output.map((chunk) => (chunk.type === type ? chunk.delta : '')).join('')).toBe(delta)
      expect(clock.time).toBeLessThanOrEqual(160)
    },
  )

  it('paces consecutive one-word deltas from one burst without extending the maximum lag', async () => {
    const clock = { time: 0 }
    const emittedAt: number[] = []
    const input = Array.from(
      { length: 50 },
      (_, index): ArrivingChunk => ({
        chunk: { type: 'text-delta', id: 'text', delta: `${index} ` },
        receivedAt: 0,
      }),
    )
    const output: AiSdkChunk[] = []
    const stream = source(...input).pipeThrough(
      paceStreamChunks({ chunking: words, delayInMs: 10 }, undefined, {
        now: () => clock.time,
        wait: async (delay) => {
          clock.time += delay
        },
      }),
    )
    for await (const chunk of stream) {
      emittedAt.push(clock.time)
      output.push(chunk)
    }
    expect(new Set(emittedAt).size).toBeGreaterThan(5)
    expect(output).toEqual(input.map(({ chunk }) => chunk))
    expect(clock.time).toBeLessThanOrEqual(160)
  })

  it('catches up immediately after delayed consumption instead of accumulating animation lag', async () => {
    const waits: number[] = []
    const chunk: AiSdkChunk = { type: 'text-delta', id: 'text', delta: 'All already arrived.' }
    const output = await collect(
      source({ chunk, receivedAt: 0 }).pipeThrough(
        paceStreamChunks({ chunking: words, delayInMs: 10 }, undefined, {
          now: () => 500,
          wait: async (delay) => {
            waits.push(delay)
          },
        }),
      ),
    )
    expect(output).toEqual([chunk])
    expect(waits).toEqual([])
  })

  it('does not wait for another fragment to complete a word', async () => {
    const chunk: AiSdkChunk = { type: 'text-delta', id: 'text', delta: 'Hel' }
    const output = await collect(
      source({ chunk, receivedAt: Date.now() }).pipeThrough(paceStreamChunks({ chunking: words, delayInMs: 10 })),
    )
    expect(output).toEqual([chunk])
  })

  it('flushes remaining received text immediately on Stop', async () => {
    const abort = new AbortController()
    const reader = source(
      { chunk: { type: 'text-delta', id: 'text', delta: 'First second third last.' }, receivedAt: Date.now() },
      { chunk: { type: 'text-end', id: 'text' }, receivedAt: Date.now() },
    )
      .pipeThrough(paceStreamChunks({ chunking: words, delayInMs: 40 }, abort.signal))
      .getReader()

    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'text', delta: 'First ' })
    abort.abort()
    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'text', delta: 'second third last.' })
    expect((await reader.read()).value?.type).toBe('text-end')
    expect((await reader.read()).done).toBe(true)
  })
})
