/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, mock } from 'bun:test'
import { createAnthropicSSEStream } from './anthropic-streaming'

const eventStream = (events: unknown[], error?: Error) =>
  ({
    controller: new AbortController(),
    [Symbol.asyncIterator]: async function* () {
      yield* events
      if (error) {
        throw error
      }
    },
  }) as never

describe('createAnthropicSSEStream', () => {
  it.each(['start', 'delta', 'buffered', 'throw', 'usage-error', 'during-accounting'] as const)(
    'records last observed usage once when canceled: %s',
    async (exit) => {
      const accounted = Promise.withResolvers<void>()
      const finishAccounting = Promise.withResolvers<void>()
      const usageError = new Error('ledger unavailable')
      const fetchFn: typeof fetch = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n' +
                      (exit === 'start'
                        ? ''
                        : 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n'),
                  ),
                )
                if (exit === 'during-accounting') {
                  controller.close()
                  return
                }
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(new DOMException('Aborted', 'AbortError')),
                  { once: true },
                )
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        },
        { preconnect: () => undefined },
      )
      const client = new Anthropic({ apiKey: 'test-key', fetch: fetchFn })
      const upstream = await client.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 100,
        messages: [],
        stream: true,
      })
      const source = {
        controller: upstream.controller,
        [Symbol.asyncIterator]: async function* () {
          yield* upstream
          if (exit === 'buffered') {
            const buffered: RawMessageStreamEvent = { type: 'message_stop' }
            yield buffered
          }
          if (exit === 'throw') {
            throw new DOMException('Aborted', 'AbortError')
          }
        },
      }
      const onUsage = mock(async (_usage: unknown) => {
        if (exit === 'usage-error') {
          throw usageError
        }
        accounted.resolve()
        if (exit === 'during-accounting') {
          await finishAccounting.promise
        }
      })
      const onUsageError = mock(() => accounted.resolve())
      const onUsageMissing = mock(() => {})
      const onError = mock(() => {})
      const reader = createAnthropicSSEStream(source, { onUsage, onUsageError, onUsageMissing, onError }).getReader()

      expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start')
      if (exit !== 'start') {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_delta')
      }
      if (exit === 'during-accounting') {
        await accounted.promise
      }
      await reader.cancel()
      finishAccounting.resolve()
      await accounted.promise
      await reader.cancel()

      expect(upstream.controller.signal.aborted).toBe(true)
      expect(onUsage).toHaveBeenCalledTimes(1)
      expect(onUsage).toHaveBeenCalledWith({
        promptTokens: 100,
        completionTokens: exit === 'start' ? 1 : 4,
        totalTokens: exit === 'start' ? 101 : 104,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      })
      expect(onUsageError).toHaveBeenCalledTimes(exit === 'usage-error' ? 1 : 0)
      if (exit === 'usage-error') {
        expect(onUsageError).toHaveBeenCalledWith(usageError)
      }
      expect(onUsageMissing).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it('encodes native events and reports cache usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 11,
            output_tokens: 1,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 5,
            cache_creation: { ephemeral_1h_input_tokens: 2, ephemeral_5m_input_tokens: 5 },
          },
        },
      },
      {
        type: 'message_delta',
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 5,
        },
      },
    ]
    const onUsage = mock(async (_usage: unknown) => {})

    const response = new Response(createAnthropicSSEStream(eventStream(events), { onUsage }))

    expect(await response.text()).toBe(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    )
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 23,
      completionTokens: 3,
      totalTokens: 26,
      cacheCreationTokens: 7,
      cacheCreation1hTokens: 2,
      cacheReadTokens: 5,
    })
  })

  it('reports missing usage after a stream with no message_start', async () => {
    const onUsageMissing = mock(() => {})
    const event = { type: 'message_stop' }

    const response = new Response(createAnthropicSSEStream(eventStream([event]), { onUsageMissing }))

    expect(await response.text()).toContain('"type":"message_stop"')
    expect(onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('reports provider stream failures', async () => {
    const error = new Error('stream failed')
    const onError = mock((_error: unknown) => {})
    const response = new Response(createAnthropicSSEStream(eventStream([], error), { onError }))

    await expect(response.text()).rejects.toThrow('stream failed')
    expect(onError).toHaveBeenCalledWith(error)
  })
})
