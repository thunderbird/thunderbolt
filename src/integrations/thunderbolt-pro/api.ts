/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import type {
  FetchContentData,
  FetchContentParams,
  LinkPreviewData,
  LinkPreviewParams,
  SearchParams,
  SearchResultData,
} from './schemas'

const requestTimeout = 10000

/**
 * Search the web via the universal /v1/search endpoint.
 */
export const search = async (params: SearchParams, httpClient: HttpClient): Promise<SearchResultData[]> => {
  try {
    const response = await httpClient
      .get('search', {
        timeout: requestTimeout,
        searchParams: { q: params.query, limit: params.max_results || 10 },
      })
      .json<{ results: SearchResultData[] }>()
    return response.results
  } catch (error) {
    console.error('Search error:', error)
    throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error })
  }
}

/**
 * Fetch and parse content from a webpage URL
 */
export const fetchContent = async (params: FetchContentParams, httpClient: HttpClient): Promise<FetchContentData> => {
  try {
    const response = await httpClient
      .post('pro/fetch-content', {
        timeout: requestTimeout,
        json: {
          url: params.url,
          ...(params.max_length !== undefined && { max_length: params.max_length }),
        },
      })
      .json<{ data: FetchContentData; success: boolean; error?: string }>()

    if (!response.success) {
      throw new Error(response.error || 'Fetch content failed')
    }

    return response.data
  } catch (error) {
    console.error('Fetch content error:', error)
    throw new Error(`Fetch content failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
      cause: error,
    })
  }
}

/**
 * Fetch link preview metadata via the universal /v1/preview endpoint.
 */
export const fetchLinkPreview = async (params: LinkPreviewParams, httpClient: HttpClient): Promise<LinkPreviewData> => {
  try {
    return await httpClient
      .post('preview', { timeout: requestTimeout, json: { url: params.url } })
      .json<LinkPreviewData>()
  } catch (error) {
    console.error('Link preview error:', error)
    throw new Error(error instanceof Error ? error.message : 'Unknown error', { cause: error })
  }
}
