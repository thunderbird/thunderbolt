/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, mock } from 'bun:test'
import { Elysia } from 'elysia'
import type { Exa } from 'exa-js'
import { createExaPlugin } from './exa'
import type { FetchContentResponse } from './types'

test.each([
  { text: 'page body', date: '2026-09-01', truncated: false },
  { text: 'x'.repeat(1000), date: '2026-09-02', truncated: true },
])(
  'real Exa plugin preserves canonical date and truncation (truncated=$truncated)',
  async ({ text, date, truncated }) => {
    const getContents = mock(async () => ({
      results: [{ id: 'page', url: 'https://source.test', title: 'Source', text, publishedDate: date }],
      requestId: 'test',
    }))
    const app = new Elysia().use(createExaPlugin({ getContents: getContents as unknown as Exa['getContents'] }))
    const response = await app.handle(
      new Request('http://localhost/fetch-content', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://source.test', max_length: 1000 }),
      }),
    )
    const body = (await response.json()) as FetchContentResponse
    expect(body.data?.publishedDate).toBe(date)
    expect(body.data).not.toHaveProperty('published_date')
    expect(body.data?.text.startsWith(text)).toBe(true)
    expect(body.data?.isTruncated).toBe(truncated)
    expect(getContents).toHaveBeenCalledTimes(1)
  },
)

test('real Exa plugin retains the existing empty-result behavior until Round 3', async () => {
  const getContents = mock(async () => ({ results: [], requestId: 'test' }))
  const app = new Elysia().use(createExaPlugin({ getContents: getContents as unknown as Exa['getContents'] }))
  const response = await app.handle(
    new Request('http://localhost/fetch-content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://source.test' }),
    }),
  )
  expect(await response.json()).toEqual({ data: null, success: true })
  expect(getContents).toHaveBeenCalledTimes(1)
})
