/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
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
  it('does not report provisional usage when the SDK ends normally after cancellation', async () => {
    const aborted = Promise.withResolvers<void>()
    const fetchFn: typeof fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
                ),
              )
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
      model: 'claude-opus-5',
      max_tokens: 100,
      messages: [],
      stream: true,
    })
    const onUsage = mock(async () => {})
    const onUsageMissing = mock(() => {})
    const onError = mock(() => {})
    const reader = createAnthropicSSEStream(upstream, { onUsage, onUsageMissing, onError }).getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start')
    await reader.cancel()
    await aborted.promise
    // Let the SDK's pending read and the consumer's post-loop continuation settle.
    await Bun.sleep(0)

    expect(upstream.controller.signal.aborted).toBe(true)
    expect(onUsage).not.toHaveBeenCalled()
    expect(onUsageMissing).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

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
