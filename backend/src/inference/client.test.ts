/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import { describe, expect, it, mock } from 'bun:test'
import { createManagedProviderConnection } from './client'

const settings = {
  anthropicApiKey: 'anthropic-key',
  anthropicBaseUrl: 'https://anthropic.test/',
  fireworksApiKey: 'fireworks-key',
}

const anthropicReply = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'Hi' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
}

describe('createManagedProviderConnection', () => {
  it('points each provider at its /v1 root with its own key', () => {
    expect(createManagedProviderConnection('anthropic', settings)).toEqual(
      expect.objectContaining({ apiKey: 'anthropic-key', baseURL: 'https://anthropic.test/v1/' }),
    )
    expect(createManagedProviderConnection('fireworks', settings)).toEqual(
      expect.objectContaining({ apiKey: 'fireworks-key', baseURL: 'https://api.fireworks.ai/inference/v1' }),
    )
  })

  it('refuses a provider without a key', () => {
    expect(() => createManagedProviderConnection('fireworks', { ...settings, fireworksApiKey: '' })).toThrow(
      'Fireworks API key not configured',
    )
  })

  it('routes an AI SDK provider through fetchFn with per-attempt telemetry', async () => {
    const fetchFn = mock(async (_input: RequestInfo | URL) =>
      Response.json(anthropicReply, { headers: { 'x-ratelimit-remaining': '9' } }),
    )
    const logger = { info: mock() }
    const connection = createManagedProviderConnection('anthropic', settings, {
      fetchFn: fetchFn as unknown as typeof fetch,
      logger,
    })

    const { text } = await generateText({ model: createAnthropic(connection)('claude-test'), prompt: 'Hello' })

    expect(text).toBe('Hi')
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://anthropic.test/v1/messages')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inference_upstream_attempt',
        provider: 'anthropic',
        host: 'anthropic.test',
        status: 200,
        rate_limit_headers: { 'x-ratelimit-remaining': '9' },
      }),
      'Inference upstream attempt',
    )
  })
})
