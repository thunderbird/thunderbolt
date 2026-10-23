/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Check, ChevronRight, Loader2 } from 'lucide-react'

type CompactionNoticeProps =
  | { status: 'compacting'; onViewSummary?: never }
  | { status: 'compacted'; onViewSummary: () => void }

/** A transcript activity row for in-progress compaction or a saved checkpoint. */
export const CompactionNotice = ({ status, onViewSummary }: CompactionNoticeProps) => {
  if (status === 'compacting') {
    return (
      <div
        role="status"
        aria-atomic="true"
        className="mt-6 flex min-h-[var(--min-touch-height)] items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground"
      >
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        <Trans>Compacting…</Trans>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onViewSummary}
      className="mt-6 flex min-h-[var(--min-touch-height)] w-full cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Check className="size-4 shrink-0" aria-hidden="true" />
      <span>
        <Trans>Compacted</Trans>
      </span>
      <span className="ml-auto flex items-center gap-2 text-xs">
        <Trans>View summary</Trans>
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </span>
    </button>
  )
}
