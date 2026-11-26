/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { type ModelMessage, streamText } from 'ai'
import { z } from 'zod'
import {
  createFakeProvider,
  cutReplyTrigger,
  fakeOpenAiModelId,
  fakeProviderReply,
  slowReplyTrigger,
} from '../../../e2e/fake-provider'

// These tests wait on the fake's real pace (150 ms a word, 3 s with `qa:slow`), so they run in `test:qa` only.
const server = await createFakeProvider(0)
afterAll(() => {
  server.close()
  server.closeAllConnections()
})
const { port } = z.object({ port: z.number() }).parse(server.address())
const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })

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

test('only text the user typed in the latest message slows the reply', async () => {
  const toolResult = [{ type: 'tool_result' as const, tool_use_id: 'tool-1', content: slowReplyTrigger }]
  for (const latest of ['Plain again', toolResult]) {
    const started = performance.now()
    const message = await client.messages.stream(request(latest, `Earlier ${slowReplyTrigger}`)).finalMessage()
    expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
    expect(performance.now() - started).toBeLessThan(2_900)
  }
})

test('a slow reply streams its first word after 3 s', async () => {
  const started = performance.now()
  const latest = [{ type: 'text' as const, text: `Again ${slowReplyTrigger}` }]
  for await (const event of client.messages.stream(request(latest))) {
    if (event.type === 'content_block_delta') {
      break
    }
  }
  expect(performance.now() - started).toBeGreaterThanOrEqual(2_900)
})

test('a cut reply streams three words, then loses its connection, and the same request again gets the whole reply', async () => {
  const cutRequest = request(`Tell me more ${cutReplyTrigger}`)
  const stream = client.messages.stream(cutRequest)
  const texts: string[] = []
  stream.on('text', (text) => texts.push(text))
  await expect(stream.finalMessage()).rejects.toThrow()
  expect(texts.join('')).toBe('Hello from the ')
  const retried = await client.messages.stream(cutRequest).finalMessage()
  expect(retried.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
})

test('a chat completion is cut the same way, after a tool call turn with no text', async () => {
  const baseURL = `http://127.0.0.1:${port}/v1`
  const model = createOpenAICompatible({ name: 'fake', baseURL, apiKey: 'test-key' }).chatModel(fakeOpenAiModelId)
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Look it up' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: {} }] },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'search', output: { type: 'text', value: 'Found' } },
      ],
    },
    { role: 'user', content: `Search again ${cutReplyTrigger}` },
  ]
  /** The text a streamed reply to `messages` delivered before it ended or broke off. */
  const streamedText = async () => {
    const texts: string[] = []
    try {
      for await (const text of streamText({ model, messages, maxRetries: 0, onError: () => {} }).textStream) {
        texts.push(text)
      }
    } catch {
      // A cut stream ends with ECONNRESET; the words that arrived before it are what this test checks.
    }
    return texts.join('')
  }
  expect(await streamedText()).toBe('Hello from the ')
  expect(await streamedText()).toBe(fakeProviderReply)
})
