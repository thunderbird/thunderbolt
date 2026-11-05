/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useShowCompactionSummary } from '@/content-view/context'
import { acpCompactionSummary, type CompactionSummary } from './compaction-summary'
import type { ThunderboltUIMessage } from '@/types'

/** Find the latest inspectable summary in transcript order without synthesizing checkpoints. */
const latestCompactionSummary = (messages: ThunderboltUIMessage[]): CompactionSummary | undefined => {
  for (const message of [...messages].reverse()) {
    if (message.metadata?.contextCompaction?.version === 1) {
      return message.metadata.contextCompaction
    }
    for (const part of [...message.parts].reverse()) {
      if (part.type === 'data-acp-compaction') {
        const summary = acpCompactionSummary(part.data)
        if (summary) {
          return summary
        }
      }
    }
  }
}

/** Open the current chat's latest saved local or remote summary in the inspection sidebar. */
export const useCompactionSummaryState = (messages: ThunderboltUIMessage[]) => {
  const showCompactionSummary = useShowCompactionSummary()
  const latest = latestCompactionSummary(messages)
  return {
    onViewSummary: latest ? () => showCompactionSummary(latest) : undefined,
  }
}
