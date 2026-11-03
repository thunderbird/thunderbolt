/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { createTinfoilWebApi } from './api'
import { createConfigs } from '@/integrations/thunderbolt-pro/tools'
import { createMockHttpClient } from '@/test-utils/http-client'
import type { SourceMetadata } from '@/types/source'

it('normalizes MCP results into ordinary search citations and fetch_content sources', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const api = createTinfoilWebApi(
    async () => 'test-key',
    async (name, args) => {
      calls.push({ name, args })
      return {
        structuredContent:
          name === 'search'
            ? {
                results: [
                  {
                    title: 'Evidence',
                    url: 'https://example.com/page',
                    content: 'A fact',
                    published_date: '2026-01-01',
                  },
                ],
              }
            : { pages: [{ url: 'https://example.com/page', content: 'Full page evidence' }] },
      }
    },
  )
  const sources: SourceMetadata[] = []
  const tools = createConfigs(createMockHttpClient(), sources, api)
  const search = await tools[0].execute({ query: 'test', max_results: 100 })
  expect(search).toMatchObject([{ pageUrl: 'https://example.com/page', sourceIndex: 1, snippet: 'A fact' }])
  expect(sources).toMatchObject([{ url: 'https://example.com/page', index: 1, title: 'Evidence', toolName: 'search' }])
  const page = await tools[1].execute({ url: 'https://example.com/page', max_length: 4 })
  expect(page).toMatchObject({ text: 'Full', isTruncated: true, sourceIndex: 1 })
  expect(sources).toHaveLength(1)
  expect(calls).toEqual([
    { name: 'search', args: { query: 'test', max_results: 30, content_mode: 'highlights' } },
    { name: 'fetch', args: { urls: ['https://example.com/page'] } },
  ])
})

it('supports text-encoded MCP payloads and empty filtered results', async () => {
  const api = createTinfoilWebApi(
    async () => '',
    async () => ({ content: [{ type: 'text', text: '{"results":[]}' }] }),
  )
  expect(await api.search({ query: 'test', max_results: 1 }, createMockHttpClient())).toEqual([])
})

it('surfaces tool failures and never presents an error as search evidence', async () => {
  const api = createTinfoilWebApi(
    async () => '',
    async () => ({ isError: true, content: [{ type: 'text', text: 'sensitive upstream details' }] }),
  )
  await expect(api.search({ query: 'test', max_results: 1 }, createMockHttpClient())).rejects.toThrow(
    'Tinfoil web search failed',
  )
})

it('rejects unsafe source URLs and failed fetch results', async () => {
  const api = createTinfoilWebApi(
    async () => '',
    async (name) => ({
      structuredContent:
        name === 'search'
          ? { results: [{ title: 'bad', url: 'javascript:alert(1)', content: 'bad' }] }
          : { results: [{ url: 'https://example.com', status: 'failed' }] },
    }),
  )
  await expect(api.search({ query: 'test', max_results: 1 }, createMockHttpClient())).rejects.toThrow()
  await expect(api.fetchContent({ url: 'https://example.com' }, createMockHttpClient())).rejects.toThrow(
    'could not retrieve',
  )
})
