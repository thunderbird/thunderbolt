/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type SearchResult } from 'exa-js'

/**
 * FetchContentData extends Exa's SearchResult with additional fields for graceful degradation.
 * - text: Truncated to maxCharacters (16K) to prevent context overflow
 * - isTruncated: Flag indicating if text was truncated
 */
export type FetchContentData = SearchResult<{ text: { maxCharacters: number } }> & {
  isTruncated: boolean
}

export type FetchContentResponse = {
  data: FetchContentData | null
  success: boolean
  error?: string | null
}
