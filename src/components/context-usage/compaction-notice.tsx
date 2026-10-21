/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Check, Loader2 } from 'lucide-react'
import type { CompactionStatus } from '@shared/agent-core'

/** Live session feedback for manual and automatic compaction, cleared by the next turn. */
export const CompactionNotice = ({
  status,
  onViewSummary,
}: {
  status?: CompactionStatus
  onViewSummary?: () => void
}) => {
  if (!status || status === 'idle') {
    return null
  }
  return (
    <div role="status" aria-atomic="true" className="text-muted-foreground text-[length:var(--font-size-xs)]">
      <div className="flex items-center gap-1.5 px-3 py-1">
        {status === 'compacting' ? (
          <>
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <Trans>Compacting…</Trans>
          </>
        ) : (
          <>
            <Check className="size-3.5 shrink-0" aria-hidden="true" />
            <Trans>Compacted</Trans>
            {onViewSummary && (
              <button
                type="button"
                onClick={onViewSummary}
                className="pointer-events-auto ml-1 cursor-pointer rounded-md underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Trans>View summary</Trans>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
