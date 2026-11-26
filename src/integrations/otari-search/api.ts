/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { isPublicWebUrl } from '@/integrations/standalone-search/url-policy'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import type { SearchResultData } from '@/integrations/thunderbolt-pro/schemas'
import { fetch as nativeFetch } from '@/lib/fetch'
import { http, HttpError, type HttpClient } from '@/lib/http'
import { getIdentitySignal } from '@/lib/identity-lifetime'

const publicUrl = z.url().refine(isPublicWebUrl)
const searchResponse = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), date: z.string().nullish() })),
})
const fetchResponse = z.object({
  url: publicUrl,
  final_url: publicUrl,
  title: z.string(),
  text: z.string(),
  published: z.string().nullish(),
  truncated: z.boolean(),
})

/** Uses Otari's direct web APIs and workspace policy; no separate client-side provider key or encryption layer. */
export const createOtariWebApi = (
  baseUrl: string,
  getApiKey: () => Promise<string>,
  client: HttpClient = http,
): Required<WebToolApi> => {
  const signal = getIdentitySignal()
  const sources = new Map<string, SearchResultData>()
  const request = async (path: 'search' | 'fetch', json: unknown) => {
    signal.throwIfAborted()
    const apiKey = await getApiKey()
    signal.throwIfAborted()
    try {
      return await client
        .post(`${baseUrl}/${path}`, {
          json,
          headers: { Authorization: `Bearer ${apiKey}` },
          credentials: 'omit',
          redirect: 'error',
          fetch: nativeFetch,
          timeout: 30_000,
          signal,
        })
        .json<unknown>()
      // Gateway errors can contain credentials; expose safe instructions without retaining their response bodies.
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof HttpError && (error.response.status === 401 || error.response.status === 403)) {
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Otari web access was denied. Reconnect Otari or check your workspace’s web access settings.')
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        'Otari could not complete this web request. Check the search provider and web access settings in Otari.',
      )
    }
  }
  return {
    allowRemoteImages: false,
    search: async ({ query, max_results }) => {
      const response = searchResponse.parse(
        await request('search', {
          query,
          max_results: Math.min(30, Math.max(1, Math.floor(max_results || 8))),
        }),
      )
      return response.results
        .filter((hit) => isPublicWebUrl(hit.url))
        .map((hit) => {
          const source: SearchResultData = {
            title: hit.title,
            pageUrl: hit.url,
            snippet: hit.snippet,
            publishedDate: hit.date ?? null,
            faviconUrl: null,
            previewImageUrl: null,
          }
          sources.set(hit.url, source)
          return source
        })
    },
    fetchContent: async ({ url, max_length }) => {
      publicUrl.parse(url)
      const limit = Math.min(64000, Math.max(1, Math.floor(max_length ?? 16000)))
      const response = fetchResponse.parse(await request('fetch', { url, max_chars: limit }))
      return {
        url: response.final_url,
        title: response.title || sources.get(url)?.title || null,
        text: response.text.slice(0, limit),
        isTruncated: response.truncated || response.text.length > limit,
        publishedDate: response.published ?? sources.get(url)?.publishedDate ?? null,
        favicon: null,
        image: null,
        author: null,
      }
    },
    fetchLinkPreview: async ({ url }) => {
      const source = sources.get(url)
      return { title: source?.title ?? null, summary: source?.snippet ?? null, siteName: null, previewImageUrl: null }
    },
  }
}
