/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'

import { z } from 'zod'
import { isPublicWebUrl, publicWebMediaUrl } from '@/integrations/standalone-search/url-policy'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import type { SearchResultData } from '@/integrations/thunderbolt-pro/schemas'
import { createTinfoilToolCaller, type TinfoilToolCaller, type TinfoilToolResult } from './transport'

const publicUrl = z.url().refine(isPublicWebUrl)
const searchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      favicon: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
})
const fetchResponse = z.object({
  pages: z.array(z.object({ url: publicUrl, content: z.string() })).optional(),
  results: z.array(z.object({ url: z.string(), status: z.string(), content: z.string().optional() })).optional(),
})

/** MCP servers may supply structured JSON or its backwards-compatible text representation. */
const resultPayload = (result: TinfoilToolResult): unknown => {
  if (result.isError) {
    throw new Error(t`Tinfoil web search failed. Check your connection and subscription, then try again.`)
  }
  if (result.structuredContent) {
    return result.structuredContent
  }
  const text = result.content?.find((item) => item.type === 'text' && item.text)?.text
  if (!text) {
    throw new Error(t`Tinfoil returned an empty web tool response.`)
  }
  return JSON.parse(text)
}

/** Adapts Tinfoil search and page retrieval to the same tool and citation contract as Exa and Brave. */
export const createTinfoilWebApi = (
  getApiKey: () => Promise<string>,
  call: TinfoilToolCaller = createTinfoilToolCaller(getApiKey),
): Required<WebToolApi> => {
  const sources = new Map<string, SearchResultData>()
  return {
    allowRemoteImages: false,
    search: async ({ query, max_results }) => {
      const response = searchResponse.parse(
        resultPayload(
          await call('search', {
            query,
            max_results: Math.min(30, Math.max(1, Math.floor(max_results || 8))),
            content_mode: 'highlights',
          }),
        ),
      )
      return response.results
        .filter((hit) => isPublicWebUrl(hit.url))
        .map((hit) => {
          const result: SearchResultData = {
            title: hit.title,
            pageUrl: hit.url,
            snippet: hit.content,
            faviconUrl: publicWebMediaUrl(hit.favicon),
            publishedDate: hit.published_date ?? null,
            previewImageUrl: null,
          }
          sources.set(hit.url, result)
          return result
        })
    },
    fetchContent: async ({ url, max_length }) => {
      publicUrl.parse(url)
      const response = fetchResponse.parse(resultPayload(await call('fetch', { urls: [url] })))
      const page =
        response.pages?.find((page) => page.url === url) ??
        response.results?.find((page) => page.url === url && page.status === 'completed' && page.content !== undefined)
      if (!page?.content?.trim()) {
        throw new Error(t`Tinfoil could not retrieve this page.`)
      }
      const source = sources.get(url)
      const limit = Math.min(64000, Math.max(1, max_length ?? 16000))
      return {
        url,
        title: source?.title ?? null,
        text: page.content.slice(0, limit),
        isTruncated: page.content.length > limit,
        favicon: source?.faviconUrl ?? null,
        image: null,
        author: null,
        publishedDate: source?.publishedDate ?? null,
      }
    },
    fetchLinkPreview: async ({ url }) => {
      const source = sources.get(url)
      return { title: source?.title ?? null, summary: source?.snippet ?? null, siteName: null, previewImageUrl: null }
    },
  }
}
