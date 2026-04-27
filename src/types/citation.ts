/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Represents a single source in a citation
 */
export type CitationSource = {
  /** Unique identifier for the source */
  id: string
  /** Title of the source article/page */
  title: string
  /** Full URL to the source */
  url: string
  /** Display name of the website/publisher (e.g., "Nature", "Wikipedia") */
  siteName?: string
  /** URL to the source's favicon */
  favicon?: string
  /** Whether this is the primary source (first/most relevant) */
  isPrimary?: boolean
}

/**
 * Map of citation placeholder indices to their decoded sources.
 * Used to replace {{CITE:N}} placeholders with inline CitationBadge components.
 */
export type CitationMap = Map<number, CitationSource[]>
