/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Citation registry for runner-executed turns.
 *
 * A locally executed turn accumulates `SourceMetadata` into the message's
 * `metadata.sources` while its tools run. A runner-executed turn cannot — the
 * tools run on Thunderbolt's servers — so each runner tool result carries its
 * own `sources` entries instead (see `shared/tools/pro-tools-contract.ts`),
 * which arrive on the ACP tool call's `rawOutput` and are journaled with it.
 * This module rebuilds the registry from those tool parts, so the same `[N]`
 * citation chips render live, on catch-up replay, and after a reload.
 */

import { fetchContentToolName, searchToolName, type SourceMetadata } from '@shared/tools/pro-tools-contract'
import { getToolName, isToolOrDynamicToolUIPart, type UIMessage } from 'ai'

/** Later entries win field-by-field: `fetch_content` re-visits a URL `search`
 *  already indexed and carries the authoritative title/description, mirroring
 *  how the local collector updates entries in place. */
const mergeSource = (existing: SourceMetadata, newer: SourceMetadata): SourceMetadata => ({
  index: existing.index,
  url: existing.url,
  title: newer.title || existing.title,
  description: newer.description || existing.description,
  image: newer.image || existing.image,
  favicon: newer.favicon || existing.favicon,
  siteName: newer.siteName || existing.siteName,
  author: newer.author || existing.author,
  publishedDate: newer.publishedDate || existing.publishedDate,
  toolName: newer.toolName,
})

/**
 * Rebuild the message's citation registry from runner tool results.
 *
 * Local tool outputs carry no `sources` field and are skipped, so this returns
 * `undefined` for locally executed turns — callers fall back to
 * `metadata.sources` first anyway.
 *
 * @param parts - the assistant message's UI parts
 */
export const deriveSourcesFromToolParts = (parts: UIMessage['parts']): SourceMetadata[] | undefined => {
  const byIndex = new Map<number, SourceMetadata>()
  for (const part of parts) {
    if (!isToolOrDynamicToolUIPart(part) || part.state !== 'output-available') {
      continue
    }
    const name = getToolName(part)
    if (name !== searchToolName && name !== fetchContentToolName) {
      continue
    }
    const sources = (part.output as { sources?: SourceMetadata[] } | null | undefined)?.sources
    if (!Array.isArray(sources)) {
      continue
    }
    for (const source of sources) {
      const existing = byIndex.get(source.index)
      byIndex.set(source.index, existing ? mergeSource(existing, source) : source)
    }
  }
  if (byIndex.size === 0) {
    return undefined
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}
