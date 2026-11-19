/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { http } from '@/lib/http'
import { createOtariWebApi } from './api'

afterEach(() => mock.restore())

it('sends search and fetch directly to Otari with its OAuth key and normalizes citation metadata', async () => {
  const requests: Request[] = []
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        requests.push(request)
        return Response.json(
          request.url.endsWith('/search')
            ? {
                results: [
                  { title: 'Example', url: 'https://example.com/page', snippet: 'Summary', date: '2026-11-05' },
                  { title: 'Private', url: 'http://127.0.0.1/secret', snippet: 'hidden' },
                ],
              }
            : {
                url: 'https://example.com/page',
                final_url: 'https://example.com/article',
                title: 'Article',
                text: 'Longer article',
                published: null,
                truncated: false,
              },
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const api = createOtariWebApi('https://gateway.example/api/v1', async () => 'delegated-key')
  expect(await api.search({ query: 'test query', max_results: 50 }, http)).toEqual([
    {
      title: 'Example',
      pageUrl: 'https://example.com/page',
      snippet: 'Summary',
      publishedDate: '2026-11-05',
      faviconUrl: null,
      previewImageUrl: null,
    },
  ])
  expect(await api.fetchContent({ url: 'https://example.com/page', max_length: 6 }, http)).toMatchObject({
    url: 'https://example.com/article',
    title: 'Article',
    text: 'Longer',
    isTruncated: true,
  })
  expect(await requests[0].json()).toEqual({ query: 'test query', max_results: 30 })
  expect(await requests[1].json()).toEqual({ url: 'https://example.com/page', max_chars: 6 })
  for (const request of requests) {
    expect(request.url).toStartWith('https://gateway.example/api/v1/')
    expect(request.headers.get('Authorization')).toBe('Bearer delegated-key')
    expect(request.headers.has('X-App-Version')).toBe(false)
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
  }
  expect(api.allowRemoteImages).toBe(false)
  expect(await api.fetchLinkPreview({ url: 'https://example.com/page' }, http)).toMatchObject({
    title: 'Example',
    summary: 'Summary',
  })
  expect(requests).toHaveLength(2)
})

it('rejects private URLs before the request and rejects private redirect results', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      url: 'https://example.com',
      final_url: 'http://127.0.0.1',
      title: '',
      text: 'private',
      truncated: false,
    }),
  )
  const api = createOtariWebApi('http://localhost:8099/api/v1', async () => 'key')
  await expect(api.fetchContent({ url: 'http://127.0.0.1' }, http)).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  await expect(api.fetchContent({ url: 'https://example.com' }, http)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([400, 401, 403, 429, 500])(
  'reports a safe actionable gateway failure (%s) without retrying elsewhere',
  async (status) => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('secret upstream details', { status }))
    const api = createOtariWebApi('https://gateway.example/api/v1', async () => 'key')
    await expect(api.search({ query: 'test', max_results: 8 }, http)).rejects.toThrow(
      status === 401 || status === 403 ? 'Otari web access was denied' : 'Check the search provider',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  },
)
