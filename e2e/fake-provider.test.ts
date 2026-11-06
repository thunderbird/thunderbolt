/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createFakeProvider, fakeProviderReply } from './fake-provider'

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
