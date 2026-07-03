/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { executeProviderSearch } from './search'

/** Build a fetch stub returning queued responses in call order. */
const stubFetch = (responses: Array<{ status?: number; json?: unknown; text?: string; contentType?: string }>) => {
  let i = 0
  const calls: string[] = []
  const fn = (async (url: string | URL) => {
    calls.push(url.toString())
    const r = responses[i++] ?? { status: 500 }
    return new Response(r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

describe('executeProviderSearch', () => {
  it('parses an Exa response (results[].{title,url,text}) and keeps favicon/image', async () => {
    const { fn } = stubFetch([
      {
        json: {
          results: [
            {
              title: 'Thunderbird',
              url: 'https://thunderbird.net/',
              text: 'A free email client.',
              favicon: 'https://thunderbird.net/icon.png',
              image: 'https://thunderbird.net/og.png',
            },
          ],
        },
      },
    ])
    const results = await executeProviderSearch('exa', { apiKey: 'k' }, 'email', fn)
    expect(results).toEqual([
      {
        title: 'Thunderbird',
        url: 'https://thunderbird.net/',
        snippet: 'A free email client.',
        favicon: 'https://thunderbird.net/icon.png',
        image: 'https://thunderbird.net/og.png',
      },
    ])
  })

  it('parses a Brave response (web.results[].{title,url,description}) and derives a favicon', async () => {
    const { fn } = stubFetch([
      { json: { web: { results: [{ title: 'Example', url: 'https://example.com/a', description: 'A snippet.' }] } } },
    ])
    const results = await executeProviderSearch('brave', { apiKey: 'k' }, 'q', fn)
    expect(results).toEqual([
      {
        title: 'Example',
        url: 'https://example.com/a',
        snippet: 'A snippet.',
        favicon: 'https://example.com/favicon.ico',
        image: null,
      },
    ])
  })

  it('parses a SerpAPI response (organic_results[].{title,link,snippet})', async () => {
    const { fn } = stubFetch([
      { json: { organic_results: [{ title: 'Result', link: 'https://serp.example/x', snippet: 'Serp snippet.' }] } },
    ])
    const results = await executeProviderSearch('serpapi', { apiKey: 'k' }, 'q', fn)
    expect(results[0]).toMatchObject({ title: 'Result', url: 'https://serp.example/x', snippet: 'Serp snippet.' })
  })

  it('parses a SearXNG JSON response (results[].{title,url,content})', async () => {
    const { fn } = stubFetch([
      {
        json: { results: [{ title: 'Wiki', url: 'https://wiki.example/p', content: 'Wiki content.' }] },
        contentType: 'application/json',
      },
    ])
    const results = await executeProviderSearch('searxng', { baseUrl: 'https://searx.example.com' }, 'q', fn)
    expect(results[0]).toMatchObject({ title: 'Wiki', url: 'https://wiki.example/p', snippet: 'Wiki content.' })
  })

  it('rejects a SearXNG instance that returns HTML instead of JSON', async () => {
    const { fn } = stubFetch([{ text: '<html>...</html>', contentType: 'text/html' }])
    await expect(executeProviderSearch('searxng', { baseUrl: 'https://searx.example.com' }, 'q', fn)).rejects.toThrow(
      /JSON/,
    )
  })

  it('throws with the status on a non-ok response', async () => {
    const { fn } = stubFetch([{ status: 401, text: 'unauthorized' }])
    await expect(executeProviderSearch('exa', { apiKey: 'bad' }, 'q', fn)).rejects.toThrow(/401/)
  })

  it('falls back to the url as the title when a provider omits it', async () => {
    const { fn } = stubFetch([{ json: { results: [{ url: 'https://no-title.example/' }] } }])
    const results = await executeProviderSearch('exa', { apiKey: 'k' }, 'q', fn)
    expect(results[0].title).toBe('https://no-title.example/')
    expect(results[0].snippet).toBe('')
  })
})
