/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Metadata for a single source collected from tool results.
 * Stored on UIMessageMetadata.sources for the source registry.
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
