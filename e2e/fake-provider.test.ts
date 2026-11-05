/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, spyOn, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { z } from 'zod'
import {
  createFakeProvider,
  fakeProviderReply,
  cutReplyTrigger,
  paceOf,
  slowReplyTrigger,
  unsupportedRequestMarker,
} from './fake-provider'

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

test('the triggers set the pace, and a cut text is cut only once', () => {
  const cut = new Set<string>()
  expect(paceOf('Write a story', cut)).toEqual({ pauseMs: 150 })
  expect(paceOf(`Write a story ${slowReplyTrigger}`, cut)).toEqual({ pauseMs: 3000 })
  expect(paceOf(`Write a story ${cutReplyTrigger} 1`, cut)).toEqual({ pauseMs: 150, cutAfter: 3 })
  expect(paceOf(`Write a story ${cutReplyTrigger} 1`, cut)).toEqual({ pauseMs: 150 })
  expect(paceOf(`Write a story ${cutReplyTrigger} 2`, cut)).toEqual({ pauseMs: 150, cutAfter: 3 })
})

test('the triggers match in any case, as a phone keyboard capitalizes them', () => {
  const cut = new Set<string>()
  expect(paceOf('Qa:slow write a story', cut)).toEqual({ pauseMs: 3000 })
  expect(paceOf('QA:CUT write a story', cut)).toEqual({ pauseMs: 150, cutAfter: 3 })
})

/** A Messages request whose history holds `history` and whose latest user turn is `latest`. */
const request = (latest: Anthropic.MessageParam['content'], history = 'Hello') => ({
  model: 'test-model',
  max_tokens: 100,
  messages: [
    { role: 'user' as const, content: history },
    { role: 'assistant' as const, content: fakeProviderReply },
    { role: 'user' as const, content: latest },
  ],
})

test('only text the user typed in the latest message slows the reply', () =>
  withFakeProvider(async (origin) => {
    const client = new Anthropic({ apiKey: 'test-key', baseURL: origin, maxRetries: 0 })
    const toolResult = [{ type: 'tool_result' as const, tool_use_id: 'tool-1', content: slowReplyTrigger }]
    for (const latest of ['Plain again', toolResult]) {
      const started = performance.now()
      const message = await client.messages.stream(request(latest, `Earlier ${slowReplyTrigger}`)).finalMessage()
      expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
      expect(performance.now() - started).toBeLessThan(2_900)
    }
  }))

test('a slow reply streams its first word after 3 s', () =>
  withFakeProvider(async (origin) => {
    const client = new Anthropic({ apiKey: 'test-key', baseURL: origin, maxRetries: 0 })
    const started = performance.now()
    const latest = [{ type: 'text' as const, text: `Again ${slowReplyTrigger}` }]
    for await (const event of client.messages.stream(request(latest))) {
      if (event.type === 'content_block_delta') {
        break
      }
    }
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_900)
  }))

test('a cut reply loses its connection mid-stream, and the same request again gets the whole reply', () =>
  withFakeProvider(async (origin) => {
    const client = new Anthropic({ apiKey: 'test-key', baseURL: origin, maxRetries: 0 })
    const cutRequest = request(`Tell me more ${cutReplyTrigger}`)
    await expect(client.messages.stream(cutRequest).finalMessage()).rejects.toThrow()
    const retried = await client.messages.stream(cutRequest).finalMessage()
    expect(retried.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  }))
