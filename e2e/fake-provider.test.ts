/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createFakeProvider, fakeProviderReply } from './fake-provider'
import { performanceStreamPrompt, performanceStreamReply } from './streaming-fixture'

test('streams a complete reply over IPv4 loopback', async () => {
  const server = await createFakeProvider(0)
  try {
    const address = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0 })
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
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('the named long markdown fixture preserves every character across fixed-size deltas', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const address = z.object({ port: z.number() }).parse(server.address())
    const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}`, maxRetries: 0 })
    const deltas: string[] = []
    const stream = client.messages.stream({
      model: 'test-model',
      max_tokens: 10_000,
      messages: [{ role: 'user', content: [{ type: 'text', text: performanceStreamPrompt }] }],
    })
    stream.on('text', (text) => deltas.push(text))
    const message = await stream.finalMessage()
    expect(deltas.length).toBeGreaterThan(100)
    expect(deltas.every((text) => text.length <= 24)).toBe(true)
    expect(deltas.join('')).toBe(performanceStreamReply)
    expect(message.content).toMatchObject([{ type: 'text', text: performanceStreamReply }])
    expect(message.stop_reason).toBe('end_turn')

    const normal = await client.messages
      .stream({
        model: 'test-model',
        max_tokens: 100,
        messages: [
          { role: 'user', content: performanceStreamPrompt },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'Hello again.' },
        ],
      })
      .finalMessage()
    expect(normal.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('rejects malformed requests without breaking subsequent streams', async () => {
  const server = await createFakeProvider(0, { delayMs: 0 })
  try {
    const { port } = z.object({ port: z.number() }).parse(server.address())
    const baseURL = `http://127.0.0.1:${port}`
    for (const body of ['{', 'null', '{}', '{"messages":{}}', '{"messages":[{"role":"user","content":42}]}']) {
      const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', body })
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid Messages request')
    }
    const client = new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 })
    const message = await client.messages
      .stream({ model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'Hello again' }] })
      .finalMessage()
    expect(message.content).toMatchObject([{ type: 'text', text: fakeProviderReply }])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
