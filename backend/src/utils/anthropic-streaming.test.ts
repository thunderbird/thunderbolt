/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
