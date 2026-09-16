/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, mock } from 'bun:test'
import { Elysia } from 'elysia'
import type { Exa } from 'exa-js'
import { createExaPlugin } from './exa'
import type { FetchContentResponse } from './types'

/** Exercise the production route with an injected SDK response. */
const fetchPage = async (getContents: () => Promise<unknown>, maxLength?: number): Promise<FetchContentResponse> => {
  const app = new Elysia().use(createExaPlugin({ getContents: getContents as Exa['getContents'] }))
  const response = await app.handle(
    new Request('http://localhost/fetch-content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://source.test', max_length: maxLength }),
    }),
  )
  return response.json()
}

test.each([
  { text: 'page body', date: '2026-09-01', truncated: false },
  { text: 'x'.repeat(1000), date: '2026-09-02', truncated: true },
])(
  'real Exa plugin preserves canonical date and truncation (truncated=$truncated)',
  async ({ text, date, truncated }) => {
    const getContents = mock(async () => ({
      results: [{ id: 'page', url: 'https://source.test', title: 'Source', text, publishedDate: date }],
      statuses: [{ id: 'page', status: 'success', source: 'cached' }],
      requestId: 'test',
    }))
    const body = await fetchPage(getContents, 1000)
    expect(body.data?.publishedDate).toBe(date)
    expect(body.data).not.toHaveProperty('published_date')
    expect(body.data?.text.startsWith(text)).toBe(true)
    expect(body.data?.isTruncated).toBe(truncated)
    expect(getContents).toHaveBeenCalledTimes(1)
  },
)

test.each([
  { name: 'failure status despite body text', status: 'error', text: 'Page Not Found' },
  { name: 'unknown status', status: 'pending', text: 'page body' },
  { name: 'empty result', status: 'success', text: null },
  { name: 'missing text', status: 'success', text: undefined },
  { name: 'empty text', status: 'success', text: '' },
  { name: 'whitespace text', status: 'success', text: ' \n\t ' },
])('real Exa plugin rejects $name', async ({ status, text }) => {
  const getContents = mock(async () => ({
    results: text === null ? [] : [{ id: 'page', url: 'https://source.test', text }],
    statuses: [{ id: 'page', status, source: 'live' }],
    requestId: 'test',
  }))
  expect(await fetchPage(getContents)).toEqual({
    data: null,
    success: false,
    error: expect.stringContaining('Source did not load'),
  })
  expect(getContents).toHaveBeenCalledTimes(1)
})

test.each(['success', 'error'])('matches mixed-batch statuses by result ID (%s)', async (status) => {
  const text = 'HTTP 404 Not Found means the requested resource could not be found.'
  const getContents = mock(async () => ({
    results: [
      { id: 'page', url: 'https://source.test', text },
      { id: 'other', url: 'https://other.test', text: 'Other content' },
    ],
    statuses: [
      { id: 'other', status: status === 'success' ? 'error' : 'success', source: 'live' },
      { id: 'page', status, source: 'cached' },
    ],
    requestId: 'test',
  }))
  const body = await fetchPage(getContents)
  expect(body.success).toBe(status === 'success')
  expect(body.data?.text ?? null).toBe(status === 'success' ? text : null)
})

test.each([
  { name: 'omitted statuses', statuses: undefined },
  { name: 'empty statuses', statuses: [] },
  { name: 'unmatched status ID', statuses: [{ id: 'other', status: 'error', source: 'live' }] },
])('falls back to text for $name', async ({ statuses }) => {
  for (const text of ['page body', '', ' \n\t ']) {
    const body = await fetchPage(async () => ({
      results: [{ id: 'page', url: 'https://source.test', text }],
      statuses,
      requestId: 'test',
    }))
    expect(body.success).toBe(Boolean(text.trim()))
    expect(body.data?.text ?? null).toBe(text.trim() ? text : null)
    if (!text.trim()) expect(body.error).toContain('Source did not load')
  }
})
