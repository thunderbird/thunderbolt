/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { fakeProviderReply } from './fake-provider'

test('fake provider streams a complete reply and token usage', async ({ request }) => {
  const port = process.env.FAKE_PROVIDER_PORT ?? '9878'
  const response = await request.post(`http://localhost:${port}/v1/chat/completions`, {
    data: {
      model: 'e2e-model',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  })
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('text/event-stream')
  const body = await response.text()
  expect(body.trimEnd()).toMatch(/data: \[DONE\]$/)
  const chunks: ChatCompletionChunk[] = body
    .trim()
    .split('\n\n')
    .slice(0, -1)
    .map((event) => JSON.parse(event.slice('data: '.length)))
  expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('')).toBe(fakeProviderReply)
  expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' })
  expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop')
  expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 })
})
