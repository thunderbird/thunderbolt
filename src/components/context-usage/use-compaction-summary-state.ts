/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useContentView } from '@/content-view/context'
import type { ThunderboltUIMessage } from '@/types'

/** Open the current chat's latest saved checkpoint in the shared inspection sidebar. */
export const useCompactionSummaryState = (messages: ThunderboltUIMessage[]) => {
  const { showCompactionSummary } = useContentView()
  const latest = messages.findLast((message) => message.metadata?.contextCompaction?.version === 1)?.metadata
    ?.contextCompaction
  return {
    onViewSummary: latest ? () => showCompactionSummary(latest) : undefined,
  }
}
