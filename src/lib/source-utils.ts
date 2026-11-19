/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { CitationSource } from '@/types/citation'
import type { SourceMetadata } from '@/types/source'

/**
 * Finds the source a `[N]` citation refers to. Sources are matched on their `index`
 * field, not array position, so a list merged from several turns resolves correctly.
 * Two entries share a number when a later turn met an earlier URL again, or in threads
 * from before numbering continued across turns; the later one wins because it is the
 * one the model saw most recently.
 */
export const findSourceByIndex = (sources: readonly SourceMetadata[], index: number): SourceMetadata | undefined =>
  sources.findLast((source) => source.index === index)

/**
 * Every source the assistant messages in `messages` registered, in thread order.
 * The model keeps the whole history, so this is the pool a later turn's `[N]`
 * citations may legitimately refer to.
 */
export const collectThreadSources = (messages: readonly ThunderboltUIMessage[]): SourceMetadata[] =>
  messages.flatMap((message) => (message.role === 'assistant' ? (message.metadata?.sources ?? []) : []))

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
  ...(source.allowRemoteImages === false && { allowRemoteImages: false }),
  isPrimary,
})

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
