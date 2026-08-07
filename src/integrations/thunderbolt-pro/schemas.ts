/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  fetchContentMaxLengthDescription,
  fetchContentUrlDescription,
  searchMaxResultsDescription,
  searchQueryDescription,
} from '@shared/tools/pro-tools-contract'
import type { FetchContentData, LinkPreviewData, SearchResultData } from '@shared/tools/pro-tools-contract'
import { z } from 'zod'

// Wire shapes live in the shared contract (the runner serves the same tools);
// re-exported here so existing imports keep working.
export type { FetchContentData, LinkPreviewData, SearchResultData }

/**
 * Schema for web search requests
 */
export const searchSchema = z
  .object({
    query: z.string().describe(searchQueryDescription),
    max_results: z.number().describe(searchMaxResultsDescription),
  })
  .strict()

/**
 * Schema for fetching webpage content
 */
export const fetchContentSchema = z
  .object({
    url: z.string().describe(fetchContentUrlDescription),
    max_length: z.number().optional().describe(fetchContentMaxLengthDescription),
  })
  .strict()

/**
 * Schema for link preview metadata requests
 */
export const linkPreviewSchema = z
  .object({
    url: z.string().describe('URL to fetch preview metadata from'),
  })
  .strict()

export type SearchParams = z.infer<typeof searchSchema>
export type FetchContentParams = z.infer<typeof fetchContentSchema>
export type LinkPreviewParams = z.infer<typeof linkPreviewSchema>
