/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, mock } from 'bun:test'
import { createMcpSearchApi, readMcpSearchResults } from './mcp-api'

const toolText = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test.each(['exa', 'tavily'] as const)('%s OAuth searches use MCP and filter unsafe result URLs', async (provider) => {
  const call = mock(async () =>
    toolText({
      results: [
        { url: 'https://example.com', title: 'Example', highlights: ['A highlight'], favicon: 'http://127.0.0.1/a' },
        { url: 'http://localhost/private', title: 'Private' },
      ],
    }),
  )
  const api = createMcpSearchApi(provider, async () => 'access', call)
  expect(await api.search({ query: 'query', max_results: 50 })).toMatchObject([
    { pageUrl: 'https://example.com', title: 'Example', snippet: 'A highlight' },
  ])
  expect(call).toHaveBeenCalledWith(
    provider === 'exa' ? 'web_search_advanced_exa' : 'tavily_search',
    provider === 'exa'
      ? { query: 'query', numResults: 20, enableHighlights: true }
      : { query: 'query', max_results: 20 },
  )
  await expect(api.fetchContent({ url: 'http://localhost/private' })).rejects.toThrow('Only public')
  expect(call).toHaveBeenCalledTimes(1)
})

test('accepts structured output and rejects MCP errors or malformed prose', () => {
  expect(readMcpSearchResults({ structuredContent: { results: [] }, content: [] })).toEqual([])
  expect(() => readMcpSearchResults({ isError: true, content: [] })).toThrow('Search provider')
  expect(() => readMcpSearchResults({ content: [{ type: 'text', text: 'not JSON' }] })).toThrow()
})

test('extracts Tavily content only for the requested URL and applies length limits', async () => {
  const api = createMcpSearchApi(
    'tavily',
    async () => 'access',
    async () => toolText({ results: [{ url: 'https://example.com', raw_content: 'abcdef' }] }),
  )
  expect(await api.fetchContent({ url: 'https://example.com', max_length: 3 })).toMatchObject({
    text: 'abc',
    isTruncated: true,
  })
  expect(await api.fetchContent({ url: 'https://other.example' })).toBeNull()
})

test('extracts Exa text without treating page prose as search result metadata', async () => {
  const api = createMcpSearchApi(
    'exa',
    async () => 'access',
    async () => ({ content: [{ type: 'text', text: 'page content' }] }),
  )
  expect(await api.fetchContent({ url: 'https://example.com', max_length: 4 })).toMatchObject({
    text: 'page',
    isTruncated: true,
  })
})
