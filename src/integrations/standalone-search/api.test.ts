/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createClient } from '@/lib/http'
import { createStandaloneWebApi, parseWebPage, searchBrave, searchWeb } from './api'

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

  it('extracts readable article text and metadata without script or navigation content', () => {
    const result = parseWebPage(
      '<html><head><title>Example</title><meta name="author" content="Author"></head><body><nav>Navigation</nav><main><h1>Title</h1><p>Evidence</p><script>malicious()</script></main><footer>Footer</footer></body></html>',
      'https://example.com',
    )
    expect(result.title).toBe('Example')
    expect(result.author).toBe('Author')
    expect(result.text).toContain('Evidence')
    expect(result.text).not.toContain('malicious')
    expect(result.text).not.toContain('Navigation')
    expect(result.text).not.toContain('Footer')
  })

  it('shares content and preview downloads, omits cookies and search credentials, and truncates content', async () => {
    const requests: Request[] = []
    const client = createClient({
      fetch: async (input) => {
        requests.push(input as Request)
        return new Response('<title>Evidence</title><main>Long article text</main>', {
          headers: { 'Content-Type': 'text/html' },
        })
      },
    })
    const api = createStandaloneWebApi('brave-key', client)
    const [content, preview] = await Promise.all([
      api.fetchContent({ url: 'https://example.com', max_length: 4 }, client),
      api.fetchLinkPreview({ url: 'https://example.com' }, client),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0].credentials).toBe('omit')
    expect(requests[0].headers.has('X-Subscription-Token')).toBe(false)
    expect(content?.text).toBe('Long')
    expect(content?.isTruncated).toBe(true)
    expect(preview.title).toBe('Evidence')
  })

  it('rejects non-web URLs and binary documents', async () => {
    const client = createClient({
      fetch: async () => new Response('binary', { headers: { 'Content-Type': 'application/pdf' } }),
    })
    const api = createStandaloneWebApi('key', client)
    expect(() => api.fetchContent({ url: 'file:///etc/passwd' }, client)).toThrow()
    expect(() => api.fetchContent({ url: 'https://user:secret@example.com' }, client)).toThrow()
    await expect(api.fetchContent({ url: 'https://example.com/file.pdf' }, client)).rejects.toThrow('readable text')
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
