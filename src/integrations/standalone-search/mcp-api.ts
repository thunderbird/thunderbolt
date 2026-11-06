/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import { searchMcpUrls, searchOAuthFetch, type McpSearchProvider } from '@/providers/mcp-search-auth'
import { isPublicWebUrl, publicWebMediaUrl } from './url-policy'

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
const resultSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      content: z.string().nullish(),
      text: z.string().nullish(),
      highlights: z.array(z.string()).nullish(),
      favicon: z.string().nullish(),
      image: z.string().nullish(),
      publishedDate: z.string().nullish(),
      raw_content: z.string().nullish(),
    }),
  ),
})
type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>

/** Reads machine-readable tool output, never trying to infer search results from prose. */
export const readMcpSearchResults = (result: unknown) => {
  const parsed = toolResultSchema.parse(result)
  if (parsed.isError) {
    throw new Error('Search provider could not complete the request')
  }
  const json =
    parsed.structuredContent ??
    JSON.parse(
      parsed.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n'),
    )
  return resultSchema.parse(json).results
}

/** Opens a bounded MCP session per operation and closes it on success or failure. */
const createToolCaller =
  (provider: McpSearchProvider, getAccessToken: () => Promise<string>): CallTool =>
  async (name, args) => {
    const url = new URL(searchMcpUrls[provider])
    if (provider === 'exa') {
      url.searchParams.set('tools', 'web_search_advanced_exa,web_fetch_exa')
    }
    const client = new Client({ name: 'Thunderbolt', version: '1.0.0' })
    const signal = AbortSignal.timeout(60_000)
    const send = searchOAuthFetch(signal)
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const destination = new URL(input instanceof Request ? input.url : input.toString())
        if (destination.origin !== url.origin) {
          throw new Error('Unexpected MCP destination')
        }
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${await getAccessToken()}`)
        return send(input, { ...init, headers })
      },
    })
    try {
      await client.connect(transport, { signal })
      return await client.callTool({ name, arguments: args }, undefined, { signal })
    } finally {
      await client.close()
    }
  }

/** Adapts OAuth-only MCP search to the same search widgets and web tools as API-key connections. */
export const createMcpSearchApi = (
  provider: McpSearchProvider,
  getAccessToken: () => Promise<string>,
  callTool: CallTool = createToolCaller(provider, getAccessToken),
) =>
  ({
    search: async ({ query, max_results }) => {
      const count = Math.min(20, Math.max(1, Math.floor(max_results || 10)))
      const result = await callTool(
        provider === 'exa' ? 'web_search_advanced_exa' : 'tavily_search',
        provider === 'exa' ? { query, numResults: count, enableHighlights: true } : { query, max_results: count },
      )
      return readMcpSearchResults(result)
        .filter((row) => isPublicWebUrl(row.url))
        .map((row) => ({
          pageUrl: row.url,
          title: row.title ?? row.url,
          snippet: row.highlights?.join('\n') ?? row.content ?? row.text ?? undefined,
          faviconUrl: publicWebMediaUrl(row.favicon),
          previewImageUrl: publicWebMediaUrl(row.image),
          publishedDate: row.publishedDate,
        }))
    },
    fetchContent: async ({ url, max_length }) => {
      if (!isPublicWebUrl(url)) {
        throw new Error('Only public web pages can be fetched')
      }
      const limit = Math.min(64_000, Math.max(1, max_length ?? 16_000))
      const result = await callTool(
        provider === 'exa' ? 'web_fetch_exa' : 'tavily_extract',
        provider === 'exa' ? { urls: [url], maxCharacters: limit } : { urls: [url] },
      )
      const parsed = toolResultSchema.parse(result)
      if (parsed.isError) {
        throw new Error('Search provider could not fetch this page')
      }
      if (provider === 'exa') {
        const text = parsed.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
        return {
          url,
          title: null,
          text: text.slice(0, limit),
          isTruncated: text.length >= limit,
          favicon: null,
          image: null,
          author: null,
        }
      }
      const row = readMcpSearchResults(result).find((row) => row.url === url)
      if (!row) {
        return null
      }
      const text = row.raw_content ?? row.content ?? ''
      return {
        url,
        title: row.title ?? null,
        text: text.slice(0, limit),
        isTruncated: text.length > limit,
        favicon: publicWebMediaUrl(row.favicon),
        image: null,
        author: null,
      }
    },
  }) satisfies WebToolApi
