/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Check, ChevronRight, CircleSlash, FileText, Loader2, TriangleAlert } from 'lucide-react'

const displays = {
  compacting: { icon: Loader2, label: msg`Compacting…` },
  compacted: { icon: Check, label: msg`Compacted` },
  failed: { icon: TriangleAlert, label: msg`Compaction failed` },
  cancelled: { icon: CircleSlash, label: msg`Compaction cancelled` },
  unknown: { icon: FileText, label: msg`Compaction` },
}

type CompactionNoticeProps = {
  status: keyof typeof displays
  onViewSummary?: () => void
  error?: string | null
}

const rowClass =
  'mt-6 flex min-h-[var(--min-touch-height)] items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground'

/** A transcript activity row; remote events may finish without supplying a summary. */
export const CompactionNotice = ({ status, onViewSummary, error }: CompactionNoticeProps) => {
  const { i18n } = useLingui()
  const { icon: Icon, label } = displays[status]
  const content = (
    <>
      <Icon className={`size-4 shrink-0 ${status === 'compacting' ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 break-words">
        {i18n._(label)}
        {error && <span className="block text-xs font-normal">{error}</span>}
      </span>
      {onViewSummary && (
        <span className="ml-auto flex items-center gap-2 text-xs">
          <Trans>View summary</Trans>
          <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        </span>
      )}
    </>
  )
  return onViewSummary ? (
    <button
      type="button"
      onClick={onViewSummary}
      className={`${rowClass} w-full cursor-pointer rounded-lg text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring`}
    >
      {content}
    </button>
  ) : (
    <div role="status" aria-atomic="true" className={rowClass}>
      {content}
    </div>
  )
}
