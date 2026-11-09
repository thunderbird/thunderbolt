/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { z } from 'zod'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import { getAuthToken } from '@/lib/auth-token'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { SearchParams, SearchResultData } from '@/integrations/thunderbolt-pro/schemas'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import type { SearchProvider } from './providers'
import { fetchProviderContent } from './content'
import { isPublicWebUrl, publicWebMediaUrl } from './url-policy'
import { getIdentitySignal } from '@/lib/identity-lifetime'

const searchResult = z.object({ title: z.string().nullish(), url: z.string() })
const braveResponse = z.object({
  web: z
    .object({
      results: z.array(
        searchResult.extend({
          description: z.string().nullish(),
          profile: z.object({ img: z.string().nullish() }).nullish(),
          thumbnail: z.object({ src: z.string().nullish() }).nullish(),
        }),
      ),
    })
    .optional(),
})
const exaResponse = z.object({
  results: z.array(
    searchResult.extend({
      highlights: z.array(z.string()).nullish(),
      favicon: z.string().nullish(),
      image: z.string().nullish(),
      publishedDate: z.string().nullish(),
    }),
  ),
})
const tavilyResponse = z.object({
  results: z.array(searchResult.extend({ content: z.string().nullish(), favicon: z.string().nullish() })),
})

/** Uses the same native/direct or configured proxy transport as the user's models. */
const createSearchHttpClient = () => {
  const send = createProxyFetch({
    cloudUrl: getLocalSetting('cloudUrl'),
    getProxyEnabled: computeEffectiveProxyEnabled,
    getProxyAuthToken: getAuthToken,
  })
  return createClient({ fetch: (input, init) => send(input, { ...init, redirect: 'error' }) })
}

/** Template contents stay inert; unlike DOMParser documents they cannot load snippet images or frames. */
const plainText = (html: string): string => {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.textContent ?? ''
}

/** Searches Brave with the device's own key; standalone requests go upstream directly. */
export const searchBrave = async (
  params: SearchParams,
  apiKey: string,
  client: HttpClient = createSearchHttpClient(),
  signal?: AbortSignal,
): Promise<SearchResultData[]> => {
  const response = braveResponse.parse(
    await client
      .get('https://api.search.brave.com/res/v1/web/search', {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        searchParams: { q: params.query, count: Math.min(20, Math.max(1, Math.floor(params.max_results || 10))) },
        timeout: 10000,
        signal,
      })
      .json(),
  )
  return (response.web?.results ?? [])
    .filter((result) => isPublicWebUrl(result.url))
    .map((result) => ({
      title: plainText(result.title ?? result.url),
      pageUrl: result.url,
      snippet: result.description ? plainText(result.description) : undefined,
      faviconUrl: publicWebMediaUrl(result.profile?.img),
      previewImageUrl: publicWebMediaUrl(result.thumbnail?.src),
    }))
}

/** Searches with the selected device-local provider, including during key verification. */
export const searchWeb = async (
  provider: SearchProvider,
  apiKey: string,
  params: SearchParams,
  client: HttpClient = createSearchHttpClient(),
  signal?: AbortSignal,
): Promise<SearchResultData[]> => {
  if (provider === 'brave') {
    return searchBrave(params, apiKey, client, signal)
  }
  const count = Math.min(20, Math.max(1, Math.floor(params.max_results || 10)))
  if (provider === 'exa') {
    const response = exaResponse.parse(
      await client
        .post('https://api.exa.ai/search', {
          headers: { 'x-api-key': apiKey },
          json: { query: params.query, type: 'auto', numResults: count, contents: { highlights: true } },
          timeout: 10000,
          signal,
        })
        .json(),
    )
    return response.results
      .filter((result) => isPublicWebUrl(result.url))
      .map((result) => ({
        title: plainText(result.title ?? result.url),
        pageUrl: result.url,
        snippet: result.highlights?.map(plainText).join('\n'),
        faviconUrl: publicWebMediaUrl(result.favicon),
        previewImageUrl: publicWebMediaUrl(result.image),
        publishedDate: result.publishedDate ?? null,
      }))
  }
  const response = tavilyResponse.parse(
    await client
      .post('https://api.tavily.com/search', {
        headers: { Authorization: `Bearer ${apiKey}` },
        json: { query: params.query, max_results: count, search_depth: 'basic', include_favicon: true },
        timeout: 10000,
        signal,
      })
      .json(),
  )
  return response.results
    .filter((result) => isPublicWebUrl(result.url))
    .map((result) => ({
      title: plainText(result.title ?? result.url),
      pageUrl: result.url,
      snippet: result.content ? plainText(result.content) : undefined,
      faviconUrl: publicWebMediaUrl(result.favicon),
      previewImageUrl: null,
    }))
}

/** Verifies a key with one small search using the agent's actual transport. */
export const testSearchProvider = async (
  provider: SearchProvider,
  apiKey: string,
  signal: AbortSignal,
): Promise<void> => {
  await searchWeb(provider, apiKey, { query: 'Thunderbird', max_results: 1 }, undefined, signal)
}

/** Exposes only capabilities supported by the selected provider; no arbitrary page downloads run on the device. */
export const createStandaloneWebApi = (
  apiKey: string | (() => Promise<string>),
  client: HttpClient = createSearchHttpClient(),
  provider: SearchProvider = 'brave',
): WebToolApi => {
  const signal = getIdentitySignal()
  const getApiKey = async () => {
    signal.throwIfAborted()
    const key = typeof apiKey === 'string' ? apiKey : await apiKey()
    signal.throwIfAborted()
    return key
  }
  return {
    search: async (params) => searchWeb(provider, await getApiKey(), params, client, signal),
    ...(provider === 'brave'
      ? {}
      : {
          fetchContent: async (params) => fetchProviderContent(provider, await getApiKey(), params, client, signal),
        }),
  }
}
