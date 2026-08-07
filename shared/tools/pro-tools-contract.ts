/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract of the Pro web tools (`search`, `fetch_content`).
 *
 * Each tool exists twice — once in the browser harness and once in the runner
 * (`cloud-runner/`) — and both are thin wrappers over the same backend
 * endpoints (`GET /v1/search`, `POST /v1/pro/fetch-content`, `POST
 * /v1/preview`) authenticated with the user's own bearer. The names,
 * descriptions, argument docs, and response shapes live here so the model is
 * offered the identical tool wherever the turn executes; restating them per
 * harness would let the two drift apart.
 *
 * Source labeling is part of the contract too: results carry a
 * `[Source N] (cite as [N])` label and the model cites `[N]` in its prose, so
 * both harnesses must number sources the same way for citations to make sense.
 *
 * Tool results additionally carry `sources: SourceMetadata[]` — the citation
 * registry entries for that call. The browser harness accumulates them into
 * the message's `metadata.sources`; runner results travel as the ACP tool
 * call's `rawOutput`, from which the client derives the same registry (see
 * `src/integrations/thunderbolt-pro/tool-part-sources.ts`). Either way the
 * same `[N]` citation chips render.
 */

/** Name of the web-search agent tool. */
export const searchToolName = 'search'

/** Name of the webpage-content agent tool. */
export const fetchContentToolName = 'fetch_content'

/** Model-facing description of the `search` tool. */
export const searchToolDescription =
  'Search the web. Each result has a [Source N] label. Cite with [N] at end of sentence.'

/** Model-facing description of the `fetch_content` tool. */
export const fetchContentToolDescription =
  'Fetch and parse content from a PUBLIC webpage URL. Result has a [Source N] label. Cite with [N] at end of sentence. Do NOT use for Google Drive, Docs, Sheets, or Slides links. Do NOT use for OneDrive or SharePoint links (use microsoft_get_onedrive_file_content instead).'

/** Description of the `search` tool's `query` argument. */
export const searchQueryDescription = 'The search query string'

/** Description of the `search` tool's `max_results` argument. */
export const searchMaxResultsDescription = 'Maximum number of results to return'

/** Description of the `fetch_content` tool's `url` argument. */
export const fetchContentUrlDescription = 'Webpage URL to fetch content from'

/** Description of the `fetch_content` tool's `max_length` argument. */
export const fetchContentMaxLengthDescription =
  'Maximum content length in characters (default: 16000, max: 64000). Increase if content was truncated.'

/**
 * Data type for search results returned by the universal search API. Shape
 * matches `GET /v1/search` — only the four fields that the app actually
 * renders, all HTTPS-only.
 */
export type SearchResultData = {
  title: string
  pageUrl: string
  faviconUrl: string | null
  previewImageUrl: string | null
  /** Optional source index assigned client-side when results are merged into a chat. */
  sourceIndex?: number
}

/**
 * Data type for fetched webpage content.
 * - text: May be truncated to ~16K chars to prevent context overflow
 * - isTruncated: True if text was truncated
 */
export type FetchContentData = {
  url: string
  title: string | null
  text: string
  isTruncated?: boolean
  highlights?: string[]
  highlightScores?: number[]
  favicon: string | null
  image: string | null
  author: string | null
  published_date: string | null
  sourceIndex?: number
} | null

/**
 * Data type for link preview metadata returned by GET /v1/preview.
 * Field names match the universal API exactly so the widget can consume them
 * without a translation layer.
 */
export type LinkPreviewData = {
  previewImageUrl: string | null
  summary: string | null
  title: string | null
  siteName: string | null
}

/**
 * Metadata for a single source collected from tool results.
 * The client's citation registry entry: locally accumulated into
 * `UIMessageMetadata.sources`, on the runner carried per tool result.
 */
export type SourceMetadata = {
  /** 1-based sequential index, matches AI's [N] reference */
  index: number
  /** Full URL of the source */
  url: string
  /** Title of the source page/article (fallback to URL) */
  title: string
  /** Description or summary (from search summary or fetch_content text snippet) */
  description?: string
  /** Image URL if available */
  image?: string | null
  /** Favicon URL if available */
  favicon?: string | null
  /** Display name of the website (derived from hostname) */
  siteName?: string
  /** Author of the source content */
  author?: string | null
  /** Publication date of the source */
  publishedDate?: string | null
  /** Which tool produced this source */
  toolName: 'search' | 'fetch_content'
}

/** Most sources one conversation tracks; past it, indexes keep advancing but
 *  entries are no longer stored (so later duplicates of a dropped URL cannot
 *  be deduplicated). */
export const sourceRegistryCap = 200

/**
 * The label a source-producing tool result carries so the model can cite it.
 *
 * @param index - the 1-based source index assigned to the result's URL
 */
export const formatSourceLabel = (index: number): string => `[Source ${index}] (cite as [${index}])`

/**
 * Derives a site name from a URL's hostname.
 * Strips "www." prefix and returns the remaining hostname.
 * Returns undefined if the URL is invalid.
 */
export const deriveSiteName = (url: string): string | undefined => {
  try {
    const hostname = new URL(url).hostname
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname
  } catch {
    return undefined
  }
}
