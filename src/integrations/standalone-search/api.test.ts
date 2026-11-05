/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createClient } from '@/lib/http'
import { createStandaloneWebApi, searchBrave, searchWeb } from './api'

describe('standalone web tools', () => {
  it('searches Brave with only its own key and caps the requested result count', async () => {
    const requests: Request[] = []
    const client = createClient({
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({
          web: {
            results: [
              { title: '<strong>Example</strong>', url: 'https://example.com', description: 'Some <b>evidence</b>' },
            ],
          },
        })
      },
    })
    const results = await searchBrave({ query: 'some query', max_results: 100 }, 'brave-key', client)
    expect(requests).toHaveLength(1)
    const url = new URL(requests[0].url)
    expect(url.origin).toBe('https://api.search.brave.com')
    expect(url.searchParams.get('q')).toBe('some query')
    expect(url.searchParams.get('count')).toBe('20')
    expect(requests[0].headers.get('X-Subscription-Token')).toBe('brave-key')
    expect(requests[0].headers.has('Authorization')).toBe(false)
    expect(requests[0].headers.has('X-App-Version')).toBe(false)
    expect(results[0]).toMatchObject({ title: 'Example', snippet: 'Some evidence', pageUrl: 'https://example.com' })
  })

  it('handles an empty search response', async () => {
    const client = createClient({ fetch: async () => Response.json({}) })
    expect(await searchBrave({ query: 'nothing', max_results: 3 }, 'key', client)).toEqual([])
  })
})

describe('search provider routing', () => {
  it.each(['exa', 'tavily'] as const)('uses %s credentials and normalizes results', async (provider) => {
    const requests: Request[] = []
    const client = createClient({
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({
          results: [{ title: 'Evidence', url: 'https://example.com', content: 'Summary', highlights: ['Summary'] }],
        })
      },
    })
    const result = await searchWeb(provider, 'own-key', { query: 'example', max_results: 3 }, client)
    const request = requests[0]
    expect(request.url).toBe(provider === 'exa' ? 'https://api.exa.ai/search' : 'https://api.tavily.com/search')
    expect(request.headers.get(provider === 'exa' ? 'x-api-key' : 'Authorization')).toBe(
      provider === 'exa' ? 'own-key' : 'Bearer own-key',
    )
    expect(request.headers.has('X-Subscription-Token')).toBe(false)
    expect(request.headers.has('X-App-Version')).toBe(false)
    const body = await request.json()
    expect(body.query).toBe('example')
    expect(body[provider === 'exa' ? 'numResults' : 'max_results']).toBe(3)
    expect(result[0]).toMatchObject({ title: 'Evidence', pageUrl: 'https://example.com', snippet: 'Summary' })
  })

  it('propagates authorization failures', async () => {
    const client = createClient({ fetch: async () => new Response('', { status: 401 }) })
    await expect(searchWeb('exa', 'bad', { query: 'test', max_results: 1 }, client)).rejects.toThrow('401')
  })
})

it('exposes Brave search without an unsupported page-content tool', () => {
  const api = createStandaloneWebApi('key', createClient(), 'brave')
  expect(api.fetchContent).toBeUndefined()
  expect(api.fetchLinkPreview).toBeUndefined()
})

describe('provider media URLs', () => {
  it.each(['exa', 'brave', 'tavily'] as const)(
    'discards unsafe %s metadata while retaining search evidence',
    async (provider) => {
      const image = 'http://127.0.0.1/private.png'
      const favicon = 'javascript:alert(1)'
      const result = {
        title: 'Evidence',
        url: 'https://example.com',
        favicon,
        image,
        profile: { img: favicon },
        thumbnail: { src: image },
      }
      const client = createClient({
        fetch: async () => Response.json({ results: [result], web: { results: [result] } }),
      })
      const results = await searchWeb(provider, 'key', { query: 'test', max_results: 1 }, client)
      expect(results).toMatchObject([{ title: 'Evidence', faviconUrl: null, previewImageUrl: null }])
    },
  )

  it.each(['exa', 'brave', 'tavily'] as const)('preserves public %s metadata', async (provider) => {
    const image = 'https://example.com/preview.png'
    const favicon = 'https://example.com/favicon.ico'
    const result = {
      title: 'Evidence',
      url: 'https://example.com',
      favicon,
      image,
      profile: { img: favicon },
      thumbnail: { src: image },
    }
    const client = createClient({ fetch: async () => Response.json({ results: [result], web: { results: [result] } }) })
    const results = await searchWeb(provider, 'key', { query: 'test', max_results: 1 }, client)
    expect(results).toMatchObject([
      {
        faviconUrl: favicon,
        previewImageUrl: provider === 'tavily' ? null : image,
      },
    ])
  })
})

describe('search result boundaries', () => {
  it.each(['exa', 'brave', 'tavily'] as const)('keeps only public %s source URLs', async (provider) => {
    const unsafeUrls = [
      'javascript:alert(1)',
      'file:///private',
      'https://localhost/private',
      'https://127.0.0.1/private',
      'https://[::1]/private',
      'https://10.0.0.1/private',
      'https://user:password@example.com/private',
    ]
    const results = [...unsafeUrls, 'https://example.com/article'].map((url) => ({ title: 'Evidence', url }))
    const client = createClient({ fetch: async () => Response.json({ results, web: { results } }) })
    expect(await searchWeb(provider, 'key', { query: 'test', max_results: 10 }, client)).toMatchObject([
      { title: 'Evidence', pageUrl: 'https://example.com/article' },
    ])
  })

  it.each(['exa', 'brave', 'tavily'] as const)(
    'handles untitled %s results without inventing a title',
    async (provider) => {
      const results = [{ title: null, url: 'https://example.com/article' }]
      const client = createClient({ fetch: async () => Response.json({ results, web: { results } }) })
      expect(await searchWeb(provider, 'key', { query: 'test', max_results: 1 }, client)).toMatchObject([
        { title: 'https://example.com/article' },
      ])
    },
  )

  it.each(['exa', 'brave', 'tavily'] as const)('rejects malformed %s result payloads', async (provider) => {
    const results = [{ title: 'Evidence' }]
    const client = createClient({ fetch: async () => Response.json({ results, web: { results } }) })
    await expect(searchWeb(provider, 'key', { query: 'test', max_results: 1 }, client)).rejects.toThrow()
  })

  it('extracts decoded snippet text without adding provider markup to the document', async () => {
    const originalBody = document.body.innerHTML
    const client = createClient({
      fetch: async () =>
        Response.json({
          web: {
            results: [
              {
                title: 'Research &amp; development',
                url: 'https://example.com',
                description:
                  'Some <strong>evidence</strong><img src="https://localhost/private"><iframe src="https://localhost/private"></iframe>',
              },
            ],
          },
        }),
    })
    expect(await searchBrave({ query: 'test', max_results: 1 }, 'key', client)).toMatchObject([
      { title: 'Research & development', snippet: 'Some evidence' },
    ])
    expect(document.body.innerHTML).toBe(originalBody)
  })

  it('preserves Exa publication dates for citation metadata', async () => {
    const client = createClient({
      fetch: async () =>
        Response.json({
          results: [{ title: 'Evidence', url: 'https://example.com', publishedDate: '2026-11-04' }],
        }),
    })
    expect(await searchWeb('exa', 'key', { query: 'test', max_results: 1 }, client)).toMatchObject([
      { publishedDate: '2026-11-04' },
    ])
  })
})
