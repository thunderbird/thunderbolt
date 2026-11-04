/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, spyOn, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { z } from 'zod'
import { createFakeProvider, fakeProviderReply, unsupportedRequestMarker } from './fake-provider'

/** Runs `use` against a fresh fake provider on a free port. */
const withFakeProvider = async (use: (origin: string) => Promise<void>) => {
  const server = await createFakeProvider(0)
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    await use(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

test('streams a complete reply over IPv4 loopback', () =>
  withFakeProvider(async (origin) => {
    const client = new Anthropic({ apiKey: 'test-key', baseURL: origin, maxRetries: 0 })
    const message = await client.messages
      .stream(
        {
          model: 'test-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hello' }],
        },
        { timeout: 3000 },
      )
      .finalMessage()
    expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply, citations: [] }])
    expect(message.stop_reason).toBe('end_turn')
  }))

test('streams a complete OpenAI-compatible chat completion with usage', () =>
  withFakeProvider(async (origin) => {
    const provider = createOpenAICompatible({ name: 'fake', baseURL: `${origin}/v1`, includeUsage: true })
    const result = streamText({ model: provider('test-model'), prompt: 'Hello', maxRetries: 0 })
    expect(await result.text).toBe(fakeProviderReply)
    expect(await result.finishReason).toBe('stop')
    expect(await result.usage).toMatchObject({ inputTokens: 10, outputTokens: 8, totalTokens: 18 })
  }))

test.each([
  ['POST', '/v1/responses', { stream: true }, 'POST /v1/responses'],
  ['POST', '/v1/chat/completions', { stream: false }, 'POST /v1/chat/completions without "stream": true'],
  ['GET', '/v1/models', undefined, 'GET /v1/models'],
  ['POST', '/proxy/v1/chat/completions', { stream: true }, 'POST /proxy/v1/chat/completions'],
  ['POST', '/v1/messages', 'not json', 'POST /v1/messages with a body that is not a JSON request'],
])('answers %s %s with a 404 and logs it as unsupported', (method, path, body, request) =>
  withFakeProvider(async (origin) => {
    const log = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = await fetch(`${origin}${path}`, { method, body: body && JSON.stringify(body) })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe(`The fake provider does not implement ${request}`)
      const lines = log.mock.calls.map(([text]) => String(text))
      const marker = RegExp.escape(unsupportedRequestMarker)
      expect(lines).toEqual([expect.stringMatching(new RegExp(`^${marker} \\S+Z ${RegExp.escape(request)}$`))])
    } finally {
      log.mockRestore()
    }
  }),
)
