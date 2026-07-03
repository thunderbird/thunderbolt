/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderById, getProviderCredentials, getSettings, type Provider } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { HttpClient } from '@/lib/http'
import { freeSearchDuckDuckGo } from '@/lib/providers/free-search'
import type { ProviderRequestContext } from '@/lib/providers/requests'
import { executeProviderSearch, type SearchResult } from '@/lib/providers/search'
import type { ProviderType } from '../../../shared/providers'
import { search } from './api'
import type { SearchResultData } from './schemas'

/** Adapt the backend `SearchResultDto` shape into the normalized `SearchResult`. */
const fromSearchResultData = (r: SearchResultData): SearchResult => ({
  title: r.title,
  url: r.pageUrl,
  snippet: '',
  favicon: r.faviconUrl,
  image: r.previewImageUrl,
})

/** Route a query to a user-configured provider (keyless DDG or a JSON provider). */
const searchWithProvider = async (
  db: AnyDrizzleDatabase,
  provider: Provider,
  query: string,
  fetchFn: typeof fetch,
  numResults: number,
): Promise<SearchResult[]> => {
  const type = provider.type as ProviderType
  if (type === 'duckduckgo') {
    return freeSearchDuckDuckGo(query, fetchFn, numResults)
  }
  const credentials = await getProviderCredentials(db, provider.id)
  const ctx: ProviderRequestContext = { apiKey: credentials?.apiKey, baseUrl: provider.baseUrl ?? undefined }
  return executeProviderSearch(type, ctx, query, fetchFn, numResults)
}

export type WebSearchDeps = {
  db: AnyDrizzleDatabase
  workspaceId: string
  /** Used for the backend Exa system-default fallback. */
  httpClient: HttpClient
  /** Proxy-aware fetch used for user-provider requests (web: `/v1/proxy`, desktop: direct). */
  fetchFn: typeof fetch
}

/**
 * Run a web search, routing to the user's configured `search_provider_id` when
 * set, otherwise falling back to the backend Exa system default. Returns results
 * in the normalized {@link SearchResult} shape regardless of source.
 */
export const runWebSearch = async (
  { db, workspaceId, httpClient, fetchFn }: WebSearchDeps,
  query: string,
  numResults = 10,
): Promise<SearchResult[]> => {
  const { searchProviderId } = await getSettings(db, { search_provider_id: '' })
  if (searchProviderId) {
    const provider = await getProviderById(db, workspaceId, searchProviderId)
    if (provider) {
      return searchWithProvider(db, provider, query, fetchFn, numResults)
    }
  }
  const results = await search({ query, max_results: numResults }, httpClient)
  return results.map(fromSearchResultData)
}
