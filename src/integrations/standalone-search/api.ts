/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import { getAuthToken } from '@/lib/auth-token'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { SearchParams, SearchResultData } from '@/integrations/thunderbolt-pro/schemas'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import type { SearchProvider } from './providers'

type BraveResponse = {
  web?: {
    results: Array<{
      title: string
      url: string
      description?: string
      profile?: { img?: string }
      thumbnail?: { src?: string }
    }>
  }
}

/** Uses the same native/direct or configured proxy transport as the user's models. */
const createSearchHttpClient = () =>
  createClient({
    fetch: createProxyFetch({
      cloudUrl: getLocalSetting('cloudUrl'),
      getProxyEnabled: computeEffectiveProxyEnabled,
      getProxyAuthToken: getAuthToken,
    }),
  })

/** Removes provider snippet markup without interpreting it as app HTML. */
const plainText = (html: string): string => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''

/** Searches Brave with the device's own key; standalone requests go upstream directly. */
export const searchBrave = async (
  params: SearchParams,
  apiKey: string,
  client: HttpClient = createSearchHttpClient(),
  signal?: AbortSignal,
): Promise<SearchResultData[]> => {
  const response = await client
    .get('https://api.search.brave.com/res/v1/web/search', {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      searchParams: { q: params.query, count: Math.min(20, Math.max(1, Math.floor(params.max_results || 10))) },
      timeout: 10000,
      signal,
    })
    .json<BraveResponse>()
  return (response.web?.results ?? []).map((result) => ({
    title: plainText(result.title),
    pageUrl: result.url,
    snippet: result.description ? plainText(result.description) : undefined,
    faviconUrl: result.profile?.img ?? null,
    previewImageUrl: result.thumbnail?.src ?? null,
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
    const response = await client
      .post('https://api.exa.ai/search', {
        headers: { 'x-api-key': apiKey },
        json: { query: params.query, type: 'auto', numResults: count, contents: { highlights: true } },
        timeout: 10000,
        signal,
      })
      .json<{
        results: Array<{ title: string; url: string; highlights?: string[]; favicon?: string; image?: string }>
      }>()
    return response.results.map((result) => ({
      title: plainText(result.title),
      pageUrl: result.url,
      snippet: result.highlights?.map(plainText).join('\n'),
      faviconUrl: result.favicon ?? null,
      previewImageUrl: result.image ?? null,
    }))
  }
  const response = await client
    .post('https://api.tavily.com/search', {
      headers: { Authorization: `Bearer ${apiKey}` },
      json: { query: params.query, max_results: count, search_depth: 'basic', include_favicon: true },
      timeout: 10000,
      signal,
    })
    .json<{ results: Array<{ title: string; url: string; content?: string; favicon?: string }> }>()
  return response.results.map((result) => ({
    title: plainText(result.title),
    pageUrl: result.url,
    snippet: result.content ? plainText(result.content) : undefined,
    faviconUrl: result.favicon ?? null,
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

/** Extracts text and metadata locally from an inert HTML document. */
export const parseWebPage = (html: string, url: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const meta = (selector: string) => doc.querySelector<HTMLMetaElement>(selector)?.content || null
  const title = meta('meta[property="og:title"]') || doc.title || null
  const summary = meta('meta[property="og:description"]') || meta('meta[name="description"]')
  const imagePath = meta('meta[property="og:image"]')
  const image = imagePath && URL.canParse(imagePath, url) ? new URL(imagePath, url).href : null
  const siteName = meta('meta[property="og:site_name"]')
  const author = meta('meta[name="author"]')
  const publishedDate = meta('meta[property="article:published_time"]')
  for (const node of doc.querySelectorAll('script,style,noscript,template,nav,footer,header,form,iframe,svg')) {
    node.remove()
  }
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')
    if (href && URL.canParse(href, url)) {
      const target = new URL(href, url)
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        anchor.append(` (${target.href})`)
      }
    }
  }
  for (const node of doc.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,h5,h6,br,tr')) {
    node.append('\n')
  }
  const text =
    (doc.querySelector('main, article') ?? doc.body).textContent
      ?.replace(/[\t ]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim() ?? ''
  return { url, title, text, image, siteName, summary, author, publishedDate, favicon: null }
}

/** Shares page downloads between content and preview tools for one model turn. */
export const createStandaloneWebApi = (
  apiKey: string,
  client: HttpClient = createSearchHttpClient(),
  provider: SearchProvider = 'brave',
): WebToolApi => {
  const pages = new Map<string, Promise<ReturnType<typeof parseWebPage>>>()
  const loadPage = (url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Web pages must use HTTP or HTTPS without embedded credentials.')
    }
    const cached = pages.get(url)
    if (cached) {
      return cached
    }
    const pending = (async () => {
      const response = await client.get(url, { timeout: 10000, credentials: 'omit' })
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !/text\/|application\/(json|xml|xhtml\+xml)/i.test(contentType)) {
        throw new Error('This URL does not contain a readable text page.')
      }
      const text = await response.text()
      return contentType.includes('html') || !contentType
        ? parseWebPage(text, response.url || url)
        : {
            url,
            title: null,
            text,
            image: null,
            siteName: null,
            summary: null,
            author: null,
            publishedDate: null,
            favicon: null,
          }
    })()
    pages.set(url, pending)
    // A transient failure must be retryable within the same model turn.
    void pending.catch(() => pages.delete(url))
    return pending
  }
  return {
    search: (params) => searchWeb(provider, apiKey, params, client),
    fetchContent: async ({ url, max_length }) => {
      const page = await loadPage(url)
      const maxLength = Math.min(64000, Math.max(1, max_length ?? 16000))
      return { ...page, text: page.text.slice(0, maxLength), isTruncated: page.text.length > maxLength }
    },
    fetchLinkPreview: async ({ url }) => {
      const page = await loadPage(url)
      return { title: page.title, summary: page.summary, siteName: page.siteName, previewImageUrl: page.image }
    },
  }
}
