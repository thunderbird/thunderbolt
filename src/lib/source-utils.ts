/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CitationSource } from '@/types/citation'
import type { SourceMetadata } from '@/types/source'
import { deriveSiteName } from '@shared/tools/pro-tools-contract'

// Now part of the shared tool contract (the runner derives site names the same
// way); re-exported so existing app imports stay put.
export { deriveSiteName }

/**
 * Converts a SourceMetadata entry to a CitationSource for the rendering pipeline.
 * Maps index to id (as string), preserves url/title/siteName/favicon.
 * @param isPrimary - Whether this is the primary (displayed) source in a group. Defaults to true.
 */
export const sourceToCitation = (source: SourceMetadata, isPrimary = true): CitationSource => ({
  id: String(source.index),
  title: source.title,
  url: source.url,
  siteName: source.siteName,
  favicon: source.favicon ?? undefined,
  isPrimary,
})
