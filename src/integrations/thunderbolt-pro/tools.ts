/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { http } from '@/lib/http'
import { deriveSiteName, findSourceByIndex } from '@/lib/source-utils'
import type { ToolConfig } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { fetchContent, fetchLinkPreview, search } from './api'
import {
  fetchContentSchema,
  searchSchema,
  type FetchContentParams,
  type SearchParams,
  type SearchResultData,
} from './schemas'

// Re-export everything from api for backward compatibility
export { fetchContent, fetchContentSchema, search, searchSchema }
export type { FetchContentParams, SearchParams, SearchResultData }

const sourceRegistryCap = 200

/** Only registered sources get numeric citations; overflow evidence remains citable by its URL. */
const withSourceReference = <T extends { sourceIndex?: number }>(result: T, source?: SourceMetadata) => ({
  ...result,
  sourceIndex: source?.index,
  sourceLabel: source ? `[Source ${source.index}] (cite as [${source.index}])` : 'Cite this source using its URL.',
})

export type WebToolApi = {
  /** Private providers must not trigger direct requests to result websites merely by rendering a citation. */
  allowRemoteImages?: boolean
  search: typeof search
  fetchContent?: typeof fetchContent
  fetchLinkPreview?: typeof fetchLinkPreview
}

/** The highest citation number in `sources`, or 0 when there are none. */
const highestIndex = (sources: readonly SourceMetadata[]): number =>
  sources.reduce((highest, { index }) => Math.max(highest, index), 0)

/**
 * Thunderbolt Pro Tools Configuration Factory
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 * @param sourceCollector - Optional shared array to accumulate source metadata during tool execution
 * @param priorSources - Sources earlier turns of the thread registered. The model still sees their
 *   `[Source N]` labels in the history, so numbering continues after them and a URL seen before
 *   keeps its number instead of getting a second label.
 */
export const createConfigs = (
  httpClient: HttpClient,
  sourceCollector?: SourceMetadata[],
  api: WebToolApi = { search, fetchContent, fetchLinkPreview },
  priorSources: readonly SourceMetadata[] = [],
): ToolConfig[] => {
  const sources = sourceCollector ?? []
  /** An earlier turn's number for `url` — unless, in a chat from before numbering spanned the
   *  thread, a later turn gave that number to another page — or else the next free number. */
  const indexFor = (url: string): number => {
    const earlier = priorSources.findLast((prior) => prior.url === url)?.index
    if (earlier !== undefined && findSourceByIndex(priorSources, earlier)?.url === url) {
      return earlier
    }
    return Math.max(highestIndex(priorSources), highestIndex(sources)) + 1
  }

  /** Deduplicates against the live collector, including when tool configs share a logical turn. */
  const collectSource = (source: Omit<SourceMetadata, 'index'>): SourceMetadata | undefined => {
    const existing = sources.find(({ url }) => url === source.url)
    if (existing) {
      if (api.allowRemoteImages === false) {
        existing.allowRemoteImages = false
      }
      return existing
    }
    if (sources.length >= sourceRegistryCap) {
      return undefined
    }
    const registered = {
      ...source,
      index: indexFor(source.url),
      ...(api.allowRemoteImages === false && { allowRemoteImages: false }),
    }
    sources.push(registered)
    return registered
  }

  const configs: ToolConfig[] = [
    {
      name: 'search',
      description: 'Search the web. Cite numbered results with [N] at end of sentence; otherwise cite the result URL.',
      verb: 'searching for {query}',
      cacheable: true,
      parameters: searchSchema,
      execute: async (params: SearchParams) => {
        const results = await api.search(params, httpClient)

        return results.map((result) => {
          const source = collectSource({
            url: result.pageUrl,
            title: result.title,
            description: result.snippet,
            image: result.previewImageUrl,
            favicon: result.faviconUrl,
            siteName: deriveSiteName(result.pageUrl),
            author: null,
            publishedDate: result.publishedDate ?? null,
            toolName: 'search',
          })
          return withSourceReference(result, source)
        })
      },
    },
  ]
  const fetchPage = api.fetchContent
  if (!fetchPage) {
    return configs
  }
  configs.push({
    name: 'fetch_content',
    description:
      'Fetch and parse content from a PUBLIC webpage URL. Cite numbered results with [N] at end of sentence; otherwise cite the result URL. Do NOT use for Google Drive, Docs, Sheets, or Slides links. Do NOT use for OneDrive or SharePoint links (use microsoft_get_onedrive_file_content instead).',
    verb: 'fetching {url}',
    cacheable: true,
    parameters: fetchContentSchema,
    execute: async (params: FetchContentParams) => {
      // Fetch content and link preview in parallel — link preview gives us og:site_name
      const [result, preview] = await Promise.all([
        fetchPage(params, httpClient),
        api.fetchLinkPreview?.({ url: params.url }, httpClient).catch(() => null) ?? Promise.resolve(null),
      ])

      if (!result) {
        return result
      }

      const ogSiteName = preview?.siteName
      const source = collectSource({
        url: result.url,
        title: result.title ?? result.url,
        description: result.text?.slice(0, 200),
        image: preview?.previewImageUrl ?? result.image,
        favicon: result.favicon,
        siteName: ogSiteName || deriveSiteName(result.url),
        author: result.author,
        publishedDate: result.publishedDate,
        toolName: 'fetch_content',
      })
      if (source) {
        // fetch_content has the authoritative page title — update the existing entry
        Object.assign(source, {
          title: result.title || source.title,
          description: result.text?.slice(0, 200) || source.description,
          image: (preview?.previewImageUrl ?? result.image) || source.image,
          favicon: result.favicon || source.favicon,
          siteName: ogSiteName || source.siteName,
          author: result.author || source.author,
          publishedDate: result.publishedDate || source.publishedDate,
        })
      }

      return withSourceReference(result, source)
    },
  })
  return configs
}

/**
 * Default configs using the default http client
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs: ToolConfig[] = createConfigs(http)
