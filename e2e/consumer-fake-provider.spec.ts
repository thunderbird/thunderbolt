/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages'
import { fakeProviderReply } from './fake-provider'

test('fake provider streams a complete reply and token usage', async ({ request }) => {
  const port = process.env.FAKE_PROVIDER_PORT ?? '9878'
  const response = await request.post(`http://localhost:${port}/v1/messages`, {
    data: {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      max_tokens: 64,
    },
  })
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('text/event-stream')
  const body = await response.text()
  const events: RawMessageStreamEvent[] = body
    .trim()
    .split('\n\n')
    .map((event) => {
      const [name, data] = event.split('\n')
      const parsed: RawMessageStreamEvent = JSON.parse(data.slice('data: '.length))
      expect(name).toBe(`event: ${parsed.type}`)
      return parsed
    })
  expect(events.map(({ type }) => type)).toEqual([
    'message_start',
    'content_block_start',
    ...fakeProviderReply.match(/\S+\s*/g)!.map(() => 'content_block_delta'),
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  expect(
    events
      .map((event) =>
        event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? event.delta.text : '',
      )
      .join(''),
  ).toBe(fakeProviderReply)
  expect(events[0]).toMatchObject({
    message: { id: expect.any(String), model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 0 } },
  })
  expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
})
