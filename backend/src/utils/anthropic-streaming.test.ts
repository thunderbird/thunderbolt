/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InferenceTokenCounts } from '@/inference/usage-ledger'
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
  it.each([
    ['the provider finishes', undefined],
    ['the provider stream fails', new Error('connection reset')],
  ] as const)('keeps reading after the client cancels, until %s, and never aborts the request', async (_, failure) => {
    const cancelled = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()
    const controller = new AbortController()
    const source = {
      controller,
      [Symbol.asyncIterator]: async function* () {
        try {
          yield { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }
          await cancelled.promise
          if (failure) {
            throw failure
          }
          yield { type: 'message_delta', usage: { output_tokens: 40 } }
          yield { type: 'message_stop' }
        } finally {
          ended.resolve()
        }
      },
    } as never
    const onUsage = mock(async (_usage: InferenceTokenCounts) => {})
    const onUsageMissing = mock(() => {})
    const onError = mock(() => {})
    const reader = createAnthropicSSEStream(source, { onUsage, onUsageMissing, onError }).getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start')
    await reader.cancel()
    cancelled.resolve()
    await ended.promise
    await Bun.sleep(0)

    expect(controller.signal.aborted).toBe(false)
    // A failure after the client left is still reported, as the only record of why the hold stays charged.
    expect(onError).toHaveBeenCalledTimes(failure ? 1 : 0)
    // A stream that fails before its final usage records nothing, so the request's hold stays charged.
    expect(onUsage.mock.calls).toEqual(
      failure ? [] : [[expect.objectContaining({ promptTokens: 100, completionTokens: 40, totalTokens: 140 })]],
    )
    expect(onUsageMissing).not.toHaveBeenCalled()
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

  it('ends the request after its usage is recorded or its stream fails', async () => {
    const events: string[] = []
    const onUsage = mock(async () => {
      events.push('usage')
    })
    const onEnd = mock(async () => {
      events.push('end')
    })
    const start = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }]

    await new Response(createAnthropicSSEStream(eventStream(start), { onUsage, onEnd })).text()
    await expect(
      new Response(createAnthropicSSEStream(eventStream([], new Error('stream failed')), { onEnd })).text(),
    ).rejects.toThrow('stream failed')

    expect(events).toEqual(['usage', 'end', 'end'])
  })

  it('reports a usage write that throws, and still ends the stream cleanly', async () => {
    const failure = new Error('ledger down')
    const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }]
    const onUsageError = mock(() => {})
    const onUsage = mock(async () => {
      throw failure
    })

    const response = new Response(createAnthropicSSEStream(eventStream(events), { onUsage, onUsageError }))

    expect(await response.text()).toContain('message_start')
    expect(onUsageError).toHaveBeenCalledTimes(1)
  })
})
