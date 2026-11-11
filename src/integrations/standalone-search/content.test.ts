/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { createClient } from '@/lib/http'
import type { SourceMetadata } from '@/types/source'
import { createConfigs } from '@/integrations/thunderbolt-pro/tools'
import { createStandaloneWebApi } from './api'
import { fetchProviderContent } from './content'

it.each(['exa', 'tavily'] as const)(
  'extracts %s content through its fixed provider endpoint with provider-only auth',
  async (provider) => {
    const requests: Request[] = []
    const client = createClient({
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({
          results: [
            {
              url: 'https://example.com/article',
              title: 'Evidence',
              text: 'Long article',
              raw_content: 'Long article',
              favicon: 'https://example.com/icon.png',
            },
          ],
        })
      },
    })
    const page = await fetchProviderContent(
      provider,
      'private-key',
      { url: 'https://example.com/article', max_length: 4 },
      client,
    )
    expect(page).toMatchObject({
      url: 'https://example.com/article',
      text: 'Long',
      isTruncated: true,
      favicon: 'https://example.com/icon.png',
    })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request.url).toBe(provider === 'exa' ? 'https://api.exa.ai/contents' : 'https://api.tavily.com/extract')
    expect(request.method).toBe('POST')
    expect(request.credentials).toBe('omit')
    expect(request.headers.has('X-App-Version')).toBe(false)
    expect(request.headers.get(provider === 'exa' ? 'x-api-key' : 'Authorization')).toBe(
      provider === 'exa' ? 'private-key' : 'Bearer private-key',
    )
    const body = await request.json()
    expect(body.urls).toEqual(['https://example.com/article'])
    if (provider === 'exa') {
      expect(body.text).toEqual({ maxCharacters: 5 })
    } else {
      expect(body).toMatchObject({ extract_depth: 'basic', format: 'markdown', include_favicon: true })
    }
  },
)

it.each(['exa', 'tavily'] as const)(
  'registers only supported %s tools and cites extracted content without another request',
  async (provider) => {
    const send = mock(async () =>
      Response.json({ results: [{ url: 'https://example.com/', text: 'Evidence', raw_content: 'Evidence' }] }),
    )
    const client = createClient({ fetch: send })
    const tools = createConfigs(client, [], createStandaloneWebApi('key', client, provider))
    expect(tools.map(({ name }) => name)).toEqual(['search', 'fetch_content'])
    expect(await tools[1].execute({ url: 'https://example.com/' })).toMatchObject({ text: 'Evidence', sourceIndex: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  },
)

it('does not register fetch_content for Brave', () => {
  const client = createClient()
  expect(createConfigs(client, [], createStandaloneWebApi('key', client, 'brave')).map(({ name }) => name)).toEqual([
    'search',
  ])
})

it.each(['exa', 'tavily'] as const)('rejects %s per-page failure in an HTTP 200 response', async (provider) => {
  const client = createClient({
    fetch: async () =>
      Response.json({
        results: [],
        statuses: [{ status: 'error' }],
        failed_results: [{ url: 'https://example.com/', error: 'provider private detail' }],
      }),
  })
  await expect(fetchProviderContent(provider, 'key', { url: 'https://example.com/' }, client)).rejects.toThrow(
    'could not retrieve',
  )
})

it.each(['exa', 'tavily'] as const)(
  'reports an empty %s response to the model without adding a source',
  async (provider) => {
    const client = createClient({ fetch: async () => new Response(null) })
    const sources: SourceMetadata[] = []
    const tools = createConfigs(client, sources, createStandaloneWebApi('key', client, provider))
    await expect(tools[1].execute({ url: 'https://example.com/' })).rejects.toThrow(
      'The search provider could not retrieve this page.',
    )
    expect(sources).toEqual([])
  },
)

it.each(['exa', 'tavily'] as const)('rejects %s malformed content and authorization failures', async (provider) => {
  const client = createClient({ fetch: async () => Response.json({ results: [{ url: 'https://example.com/' }] }) })
  await expect(fetchProviderContent(provider, 'key', { url: 'https://example.com/' }, client)).rejects.toThrow()
  const unauthorized = createClient({ fetch: async () => new Response('', { status: 401 }) })
  await expect(fetchProviderContent(provider, 'key', { url: 'https://example.com/' }, unauthorized)).rejects.toThrow(
    '401',
  )
})

it.each(['exa', 'tavily'] as const)('does not register empty %s page text as evidence', async (provider) => {
  const client = createClient({
    fetch: async () =>
      Response.json({
        results: [{ url: 'https://example.com/', text: ' \n ', raw_content: ' \n ' }],
      }),
  })
  const sources: SourceMetadata[] = []
  const tools = createConfigs(client, sources, createStandaloneWebApi('key', client, provider))
  await expect(tools[1].execute({ url: 'https://example.com/' })).rejects.toThrow('could not retrieve')
  expect(sources).toEqual([])
})

it.each([
  'file:///secret',
  'https://user:secret@example.com/',
  'http://localhost/',
  'http://127.1/',
  'http://2130706433/',
  'http://10.0.0.1/',
  'http://169.254.169.254/',
  'https://[::1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://server.local/',
])('rejects non-public content target %s before any request', async (url) => {
  const send = mock(async () => Response.json({ results: [] }))
  await expect(fetchProviderContent('exa', 'key', { url }, createClient({ fetch: send }))).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it('preserves Exa metadata, allows provider redirects, and drops unsafe image URLs', async () => {
  const client = createClient({
    fetch: async () =>
      Response.json({
        results: [
          {
            url: 'https://example.com/redirected',
            text: 'Content',
            title: 'Page',
            author: 'Author',
            publishedDate: '2026-01-01',
            image: 'file:///secret',
            favicon: 'http://127.0.0.1/private',
          },
        ],
      }),
  })
  expect(await fetchProviderContent('exa', 'key', { url: 'https://example.com/' }, client)).toMatchObject({
    url: 'https://example.com/redirected',
    title: 'Page',
    author: 'Author',
    publishedDate: '2026-01-01',
    image: null,
    favicon: null,
    isTruncated: false,
  })
})

it('caps requested text and returned content without fetching the supplied URL', async () => {
  const send = mock(async (input: RequestInfo | URL) => {
    expect((await (input as Request).json()).text).toEqual({ maxCharacters: 64001 })
    return Response.json({ results: [{ url: 'https://example.com/', text: 'a'.repeat(64001) }] })
  })
  const result = await fetchProviderContent(
    'exa',
    'key',
    { url: 'https://example.com/', max_length: 100000 },
    createClient({ fetch: send }),
  )
  expect(result?.text.length).toBe(64000)
  expect(result?.isTruncated).toBe(true)
})

it.each(['exa', 'tavily'] as const)(
  'cancels oversized %s responses before reading advertised bodies',
  async (provider) => {
    const cancel = mock(() => {})
    const read = mock(() => new Promise<never>(() => {}))
    const client = createClient({
      fetch: async () =>
        new Response(new ReadableStream({ pull: read, cancel }), { headers: { 'content-length': '10000000' } }),
    })
    await expect(fetchProviderContent(provider, 'key', { url: 'https://example.com/' }, client)).rejects.toThrow(
      'too much content',
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  },
)

it.each([undefined, '5'])(
  'cancels chunked provider content past the byte limit (advertised length: %s)',
  async (length) => {
    const cancel = mock(() => {})
    const chunk = new Uint8Array(600_000).fill(32)
    let reads = 0
    const client = createClient({
      fetch: async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                reads++
                controller.enqueue(chunk)
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { headers: length ? { 'content-length': length } : {} },
        ),
    })
    await expect(fetchProviderContent('tavily', 'key', { url: 'https://example.com/' }, client)).rejects.toThrow(
      'too much content',
    )
    expect(reads).toBe(2)
    expect(cancel).toHaveBeenCalledTimes(1)
  },
)

it('decodes a bounded JSON response split inside a Unicode character', async () => {
  const json = new TextEncoder().encode(
    JSON.stringify({ results: [{ url: 'https://example.com/', raw_content: 'Résumé' }] }),
  )
  const accent = json.indexOf(0xc3)
  const client = createClient({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(json.slice(0, accent + 1))
            controller.enqueue(json.slice(accent + 1))
            controller.close()
          },
        }),
      ),
  })
  expect(await fetchProviderContent('tavily', 'key', { url: 'https://example.com/' }, client)).toMatchObject({
    text: 'Résumé',
    isTruncated: false,
  })
})

it('cancels a stalled response body when the deadline expires after headers arrive', async () => {
  const cancel = mock(() => {})
  const reading = Promise.withResolvers<void>()
  const client = createClient({
    fetch: async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              reading.resolve()
              return new Promise<never>(() => {})
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
  })
  const failure = fetchProviderContent('tavily', 'key', { url: 'https://example.com/' }, client).catch(
    (error: unknown) => error,
  )
  await reading.promise
  await getClock().tickAsync(30_000)
  expect(await failure).toMatchObject({ name: 'TimeoutError' })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('cancels an unread response that arrives after the request deadline', async () => {
  const cancel = mock(() => {})
  const response = Promise.withResolvers<Response>()
  const client = createClient({ fetch: async () => response.promise })
  const failure = fetchProviderContent('exa', 'key', { url: 'https://example.com/' }, client).catch(
    (error: unknown) => error,
  )
  await getClock().tickAsync(30_000)
  response.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })))
  expect(await failure).toMatchObject({ name: 'TimeoutError' })
  expect(cancel).toHaveBeenCalledTimes(1)
})
