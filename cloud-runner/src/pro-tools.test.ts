/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createProTools, createSourceRegistry, registerProTools, type ProToolsDeps } from './pro-tools.ts'
import type { ToolHost } from './render-html-tool.ts'

type RecordedRequest = { url: string; init: RequestInit }

/** Fetch stub that records requests and replies per URL substring. */
const createFetchStub = (routes: Record<string, () => Response>) => {
  const requests: RecordedRequest[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init: init ?? {} })
    const route = Object.entries(routes).find(([fragment]) => url.includes(fragment))
    if (!route) {
      throw new Error(`no stub route for ${url}`)
    }
    return route[1]()
  }) as typeof fetch
  return { fetchFn, requests }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const searchResult = (pageUrl: string) => ({
  title: `Page at ${pageUrl}`,
  pageUrl,
  faviconUrl: null,
  previewImageUrl: null,
})

const buildDeps = (
  routes: Record<string, () => Response>,
  overrides: Partial<ProToolsDeps> = {},
): { deps: ProToolsDeps; requests: RecordedRequest[] } => {
  const { fetchFn, requests } = createFetchStub(routes)
  return {
    deps: {
      backendUrl: 'http://backend.test',
      readBearer: () => 'bearer-1',
      sources: createSourceRegistry(),
      fetchFn,
      ...overrides,
    },
    requests,
  }
}

const toolByName = (deps: ProToolsDeps, name: string): AgentTool => {
  const tool = createProTools(deps).find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error(`tool ${name} not built`)
  }
  return tool
}

const resultText = (result: { content: { type: string; text?: string }[] }): string => {
  const block = result.content[0]
  if (block.type !== 'text' || block.text === undefined) {
    throw new Error('expected a text content block')
  }
  return block.text
}

describe('search tool', () => {
  it('calls the backend search endpoint with the query, limit, and bearer', async () => {
    const { deps, requests } = buildDeps({
      '/v1/search': () => json({ results: [searchResult('https://a.test/')] }),
    })

    await toolByName(deps, 'search').execute('call-1', { query: 'ports', max_results: 5 })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('http://backend.test/v1/search?q=ports&limit=5')
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe('Bearer bearer-1')
  })

  it('labels each result with its source index for citations', async () => {
    const { deps } = buildDeps({
      '/v1/search': () => json({ results: [searchResult('https://a.test/'), searchResult('https://b.test/')] }),
    })

    const result = await toolByName(deps, 'search').execute('call-1', { query: 'q', max_results: 2 })
    const payload = JSON.parse(resultText(result)) as { sourceLabel: string; sourceIndex: number; pageUrl: string }[]

    expect(payload[0]).toMatchObject({ sourceIndex: 1, sourceLabel: '[Source 1] (cite as [1])' })
    expect(payload[1]).toMatchObject({ sourceIndex: 2, sourceLabel: '[Source 2] (cite as [2])' })
  })

  it('carries the citation registry entries on the result for the client', async () => {
    const { deps } = buildDeps({
      '/v1/search': () => json({ results: [searchResult('https://www.a.test/page')] }),
    })

    const result = (await toolByName(deps, 'search').execute('call-1', { query: 'q', max_results: 1 })) as {
      sources?: unknown
    }

    expect(result.sources).toEqual([
      {
        index: 1,
        url: 'https://www.a.test/page',
        title: 'Page at https://www.a.test/page',
        image: null,
        favicon: null,
        siteName: 'a.test',
        author: null,
        publishedDate: null,
        toolName: 'search',
      },
    ])
  })

  it('reuses the index for a URL already cited this session', async () => {
    const { deps } = buildDeps({
      '/v1/search': () => json({ results: [searchResult('https://a.test/')] }),
    })
    const tool = toolByName(deps, 'search')

    const first = JSON.parse(resultText(await tool.execute('c1', { query: 'q', max_results: 1 })))
    const second = JSON.parse(resultText(await tool.execute('c2', { query: 'q again', max_results: 1 })))

    expect(first[0].sourceIndex).toBe(1)
    expect(second[0].sourceIndex).toBe(1)
  })

  it('throws with the backend status so the loop reports a readable tool error', async () => {
    const { deps } = buildDeps({ '/v1/search': () => json({}, 500) })

    await expect(toolByName(deps, 'search').execute('call-1', { query: 'q', max_results: 1 })).rejects.toThrow(
      'Search failed: backend responded 500',
    )
  })
})

describe('fetch_content tool', () => {
  const page = {
    url: 'https://a.test/page',
    title: 'A Page',
    text: 'body text',
    favicon: null,
    image: null,
    author: null,
    published_date: null,
  }

  it('posts the url and merges the link preview enrichment', async () => {
    const { deps, requests } = buildDeps({
      '/v1/pro/fetch-content': () => json({ success: true, data: page }),
      '/v1/preview': () => json({ previewImageUrl: 'https://a.test/og.png', summary: null, title: null, siteName: 'A Site' }),
    })

    const result = await toolByName(deps, 'fetch_content').execute('call-1', { url: 'https://a.test/page' })
    const payload = JSON.parse(resultText(result))

    expect(payload).toMatchObject({
      sourceIndex: 1,
      sourceLabel: '[Source 1] (cite as [1])',
      siteName: 'A Site',
      image: 'https://a.test/og.png',
      text: 'body text',
    })
    const bodies = requests.map((request) => request.init.body)
    expect(bodies).toContain(JSON.stringify({ url: 'https://a.test/page' }))
  })

  it('passes max_length through when the model asks for more content', async () => {
    const { deps, requests } = buildDeps({
      '/v1/pro/fetch-content': () => json({ success: true, data: page }),
      '/v1/preview': () => json({ previewImageUrl: null, summary: null, title: null, siteName: null }),
    })

    await toolByName(deps, 'fetch_content').execute('call-1', { url: 'https://a.test/page', max_length: 64000 })

    const fetchBody = requests.find((request) => request.url.includes('fetch-content'))?.init.body
    expect(fetchBody).toBe(JSON.stringify({ url: 'https://a.test/page', max_length: 64000 }))
  })

  it('carries an authoritative citation entry (preview siteName, text snippet) for the client', async () => {
    const { deps } = buildDeps({
      '/v1/pro/fetch-content': () => json({ success: true, data: { ...page, author: 'An Author' } }),
      '/v1/preview': () =>
        json({ previewImageUrl: 'https://a.test/og.png', summary: null, title: null, siteName: 'A Site' }),
    })

    const result = (await toolByName(deps, 'fetch_content').execute('call-1', { url: 'https://a.test/page' })) as {
      sources?: unknown
    }

    expect(result.sources).toEqual([
      {
        index: 1,
        url: 'https://a.test/page',
        title: 'A Page',
        description: 'body text',
        image: 'https://a.test/og.png',
        favicon: null,
        siteName: 'A Site',
        author: 'An Author',
        publishedDate: null,
        toolName: 'fetch_content',
      },
    ])
  })

  it('survives a failing preview — the page content is the answer', async () => {
    const { deps } = buildDeps({
      '/v1/pro/fetch-content': () => json({ success: true, data: page }),
      '/v1/preview': () => json({}, 500),
    })

    const payload = JSON.parse(
      resultText(await toolByName(deps, 'fetch_content').execute('call-1', { url: 'https://a.test/page' })),
    )
    expect(payload).toMatchObject({ text: 'body text', siteName: null })
  })

  it('throws the backend-reported error on an unsuccessful fetch', async () => {
    const { deps } = buildDeps({
      '/v1/pro/fetch-content': () => json({ success: false, error: 'blocked by robots.txt' }),
      '/v1/preview': () => json({ previewImageUrl: null, summary: null, title: null, siteName: null }),
    })

    await expect(toolByName(deps, 'fetch_content').execute('call-1', { url: 'https://a.test/page' })).rejects.toThrow(
      'blocked by robots.txt',
    )
  })

  it('shares source numbering with search, so one URL keeps one index', async () => {
    const { deps } = buildDeps({
      '/v1/search': () => json({ results: [searchResult('https://a.test/page')] }),
      '/v1/pro/fetch-content': () => json({ success: true, data: page }),
      '/v1/preview': () => json({ previewImageUrl: null, summary: null, title: null, siteName: null }),
    })

    const searched = JSON.parse(resultText(await toolByName(deps, 'search').execute('c1', { query: 'q', max_results: 1 })))
    const fetched = JSON.parse(
      resultText(await toolByName(deps, 'fetch_content').execute('c2', { url: 'https://a.test/page' })),
    )

    expect(searched[0].sourceIndex).toBe(1)
    expect(fetched.sourceIndex).toBe(1)
  })
})

describe('createSourceRegistry', () => {
  it('keeps numbering monotonic past the storage cap without deduplication', () => {
    const registry = createSourceRegistry()
    for (let i = 1; i <= 200; i++) {
      expect(registry.claim(`https://site-${i}.test/`)).toBe(i)
    }
    // Past the cap: fresh indexes, no storage — the same URL claims a new one.
    expect(registry.claim('https://site-201.test/')).toBe(201)
    expect(registry.claim('https://site-201.test/')).toBe(202)
    // Stored entries keep deduplicating.
    expect(registry.claim('https://site-1.test/')).toBe(1)
  })
})

describe('registerProTools', () => {
  const inertTool = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: null }),
  })

  const createToolHost = (initial: string[]): ToolHost & { active: string[] } => {
    const state = { tools: initial.map(inertTool), active: initial }
    return {
      get active() {
        return state.active
      },
      getTools: () => state.tools,
      setTools: async (tools, activeToolNames) => {
        state.tools = tools
        state.active = activeToolNames ?? state.active
      },
    }
  }

  it('appends both web tools to the harness toolset and marks every tool active', async () => {
    const host = createToolHost(['read', 'render_html'])
    const { deps } = buildDeps({})

    await registerProTools(host, deps)

    expect(host.getTools().map((tool) => tool.name)).toEqual(['read', 'render_html', 'search', 'fetch_content'])
    expect(host.active).toEqual(['read', 'render_html', 'search', 'fetch_content'])
  })
})
