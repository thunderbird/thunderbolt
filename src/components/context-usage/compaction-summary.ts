/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { CompactionCheckpoint } from '@shared/agent-core'
import type { AcpCompaction } from '@/acp/compaction'

/** Display data only; ACP summaries never become local Pi restore checkpoints. */
export type CompactionSummary = {
  summary: string
  retainedTail?: CompactionCheckpoint['retainedTail']
}

/** Describe ACP summary blocks without decoding binaries or fetching referenced resources. */
const summaryBlockText = (block: ContentBlock): string => {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return [block.mimeType, block.uri].filter(Boolean).join('\n')
    case 'audio':
      return block.mimeType
    case 'resource_link':
      return [block.title ?? block.name, block.description, block.uri].filter(Boolean).join('\n')
    case 'resource':
      return [block.resource.uri, 'text' in block.resource ? block.resource.text : block.resource.mimeType]
        .filter(Boolean)
        .join('\n')
  }
}

/** Offer inspection only when an ACP event contains readable summary content. */
export const acpCompactionSummary = (compaction: AcpCompaction): CompactionSummary | undefined => {
  const summary = compaction.summary
    ?.map((block, index, blocks) => {
      // Text chunks can split words or Markdown; only non-text blocks need separators.
      const adjacentText = block.type === 'text' && blocks[index - 1]?.type === 'text'
      const separator = index === 0 || adjacentText ? '' : '\n\n'
      return separator + summaryBlockText(block)
    })
    .join('')
  return summary?.trim() ? { summary } : undefined
}
